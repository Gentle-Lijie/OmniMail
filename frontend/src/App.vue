<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  Mail,
  LayoutDashboard,
  History,
  Files,
  Settings as SettingsIcon,
  Cable,
  ArrowUpRight,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import HtmlEditor from "@/components/HtmlEditor.vue";
import SettingsPage from "@/components/SettingsPage.vue";
import {
  api,
  setCsrf,
  idPath,
  ApiError,
  type AuthStatus,
  type Template,
  type Task,
  type Kind,
  type Payload,
  type Message,
  type Key,
} from "@/lib/api";
import { i18n, translate } from "@/lib/i18n";
const language = ref("zh");
watch(
  language,
  (value) => {
    i18n.global.locale.value = value === "en" ? "en" : "zh";
    document.documentElement.lang = value === "en" ? "en" : "zh-CN";
  },
  { immediate: true },
);
const t = (zh: string, en: string) => {
  void language.value;
  return translate(zh, en);
};
const page = ref("dashboard");
const pages = computed(() => [
  { id: "dashboard", name: t("工作台", "Workspace"), icon: LayoutDashboard },
  { id: "history", name: t("历史", "History"), icon: History },
  { id: "templates", name: t("模板", "Templates"), icon: Files },
  { id: "settings", name: t("设置", "Settings"), icon: SettingsIcon },
  { id: "mcp", name: "MCP", icon: Cable },
]);
const auth = ref<AuthStatus>();
const busy = ref(false);
const loading = ref(true);
const error = ref("");
const success = ref("");
const name = ref("");
const setupToken = ref("");
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.status === 401) {
      auth.value = undefined;
      await status();
    }
  } finally {
    busy.value = false;
  }
}
async function status() {
  loading.value = true;
  try {
    auth.value = await api<AuthStatus>("/auth/status");
    setCsrf(auth.value.csrfToken);
    if (auth.value.authenticated) await loadPage();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function login() {
  await run(async () => {
    const options = await api<
      Parameters<typeof startAuthentication>[0]["optionsJSON"]
    >("/auth/login/options", "POST", {});
    const response = await startAuthentication({ optionsJSON: options });
    await api("/auth/login/verify", "POST", { response });
    await status();
  });
}
async function register() {
  await run(async () => {
    const options = await api<
      Parameters<typeof startRegistration>[0]["optionsJSON"]
    >("/auth/register/options", "POST", {
      name: name.value,
      setupToken: setupToken.value || undefined,
    });
    const response = await startRegistration({ optionsJSON: options });
    await api("/auth/register/verify", "POST", { response, name: name.value });
    setupToken.value = "";
    await status();
  });
}
const templates = ref<Template[]>([]);
const tasks = ref<Task[]>([]);
const stats = ref<Record<string, number>>();
const keys = ref<Key[]>([]);
async function loadPage() {
  loading.value = true;
  try {
    if (page.value === "dashboard") {
      const [s, ts] = await Promise.all([
        api<Record<string, number>>("/dashboard"),
        api<Template[]>("/templates"),
      ]);
      stats.value = s;
      templates.value = ts;
    } else if (page.value === "history")
      tasks.value = await api<Task[]>("/tasks");
    else if (page.value === "templates")
      templates.value = await api<Template[]>("/templates");
    else if (page.value === "mcp") keys.value = await api<Key[]>("/mcp/keys");
  } finally {
    loading.value = false;
  }
}
watch(page, () => {
  detail.value = undefined;
  oneTimeKey.value = "";
  error.value = "";
  success.value = "";
  if (auth.value?.authenticated && !busy.value) void run(loadPage);
});
watch(
  language,
  () =>
    (document.documentElement.lang = language.value === "en" ? "en" : "zh-CN"),
);
const kind = ref<Kind>("email");
const payload = ref<Payload>({
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  html: "",
});
const templateId = ref("");
const rows = ref<Record<string, unknown>[]>([]);
const columns = ref<string[]>([]);
const fileName = ref("");
const conversation = ref<Message[]>([]);
const message = ref("");
const mapping = ref<Record<string, string>>();
const review = ref<Task>();
const reviewOpen = ref(false);
const detail = ref<Task>();
const filter = ref("all");
const templateFilter = ref("all");
const sourceFilter = ref("all");
const fromDate = ref("");
const toDate = ref("");
function recipientCount(task: Task) {
  return (task.items ?? []).reduce(
    (count, item) =>
      count +
      (task.kind === "email"
        ? ["to", "cc", "bcc"]
        : ["requiredAttendees", "optionalAttendees"]
      ).reduce(
        (n, key) =>
          n +
          (item.payload[key] || "").split(";").filter((x) => x.trim()).length,
        0,
      ),
    0,
  );
}
const statuses = [
  "draft",
  "queued",
  "running",
  "accepted",
  "failed",
  "uncertain",
  "cancelled",
] as const;
const stateLabel = (s: string) =>
  t(
    (
      {
        draft: "草稿",
        queued: "排队中",
        running: "执行中",
        accepted: "接口已接收",
        failed: "失败",
        uncertain: "结果不确定",
        cancelled: "已取消",
      } as Record<string, string>
    )[s] || s,
    s === "accepted" ? "Accepted by interface" : s,
  );
const filtered = computed(() =>
  tasks.value.filter(
    (x) =>
      (filter.value === "all" || x.status === filter.value) &&
      (templateFilter.value === "all" ||
        x.templateId === templateFilter.value) &&
      (sourceFilter.value === "all" ||
        (sourceFilter.value === "web"
          ? x.source === "web"
          : x.source.startsWith("mcp:"))) &&
      (!fromDate.value || x.createdAt.slice(0, 10) >= fromDate.value) &&
      (!toDate.value || x.createdAt.slice(0, 10) <= toDate.value),
  ),
);
function changeKind(value: string | number) {
  kind.value = value as Kind;
  payload.value =
    kind.value === "email"
      ? { to: "", cc: "", bcc: "", subject: "", html: "" }
      : {
          subject: "",
          start: "",
          end: "",
          requiredAttendees: "",
          optionalAttendees: "",
          location: "",
          html: "",
        };
  templateId.value = "";
  conversation.value = [];
  review.value = undefined;
}
function applyTemplate() {
  const x = templates.value.find((x) => x.id === templateId.value);
  if (x) {
    changeKind(x.kind);
    templateId.value = x.id;
    payload.value.subject = x.subject;
    payload.value.html = x.html;
  }
}
function validate() {
  if (
    !payload.value.subject.trim() ||
    (kind.value === "email" && !payload.value.html.trim())
  )
    throw Error(
      t(
        "请填写主题；邮件还需填写正文",
        "Subject is required; email also requires a body",
      ),
    );
  if (kind.value === "email" && !payload.value.to.trim())
    throw Error(
      t("请填写收件人或映射占位符", "Enter recipients or mapped placeholders"),
    );
  if (
    kind.value === "event" &&
    (!payload.value.start ||
      !payload.value.end ||
      payload.value.end <= payload.value.start)
  )
    throw Error(
      t("请填写有效的开始和结束时间", "Enter a valid start and end time"),
    );
}
async function createDraft() {
  await run(async () => {
    validate();
    review.value = await api<Task>("/tasks", "POST", {
      kind: kind.value,
      payload: payload.value,
      rows: rows.value.length ? rows.value : undefined,
      templateId: templateId.value || undefined,
      conversation: conversation.value,
    });
    review.value = await api<Task>("/tasks/" + idPath(review.value.id));
    reviewOpen.value = true;
  });
}
async function confirm() {
  await run(async () => {
    if (!review.value) return;
    await api("/tasks/" + idPath(review.value.id) + "/confirm", "POST", {});
    detail.value = await api<Task>("/tasks/" + idPath(review.value.id));
    reviewOpen.value = false;
    page.value = "history";
    success.value = t(
      "已请求排队；接口接收不等于投递成功。",
      "Queue requested; acceptance does not mean delivery.",
    );
    await loadPage();
    detail.value = await api<Task>("/tasks/" + idPath(review.value.id));
  });
}
async function openTask(x: Task) {
  await run(async () => {
    detail.value = await api<Task>("/tasks/" + idPath(x.id));
  });
}
async function cancelTask(x: Task) {
  await run(async () => {
    await api("/tasks/" + idPath(x.id) + "/cancel", "POST", {});
    detail.value = await api<Task>("/tasks/" + idPath(x.id));
    await loadPage();
  });
}
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await run(async () => {
    const form = new FormData();
    form.append("file", file);
    const data = await api<{
      columns: string[];
      rows: Record<string, unknown>[];
      count: number;
    }>("/import", "POST", form);
    columns.value = data.columns;
    rows.value = data.rows;
    fileName.value = file.name;
    success.value = t(`已解析 ${data.count} 行`, `Parsed ${data.count} rows`);
  });
  (event.target as HTMLInputElement).value = "";
}
async function ask() {
  if (!message.value.trim()) return;
  await run(async () => {
    const text = message.value;
    const res = await api<{
      message: string;
      kind: Kind;
      payload: Payload;
      templateId?: string;
      mapping?: Record<string, string>;
    }>("/agent", "POST", {
      message: text,
      conversation: conversation.value,
      kind: kind.value,
      payload: payload.value,
      columns: columns.value,
      sampleRows: rows.value
        .slice(0, 2)
        .map((row) =>
          Object.fromEntries(
            Object.keys(row).map((key) => [key, "[REDACTED]"]),
          ),
        ),
      templateId: templateId.value || undefined,
    });
    conversation.value.push(
      { role: "user", content: text },
      { role: "assistant", content: res.message },
    );
    kind.value = res.kind;
    payload.value = res.payload;
    templateId.value = res.templateId || "";
    mapping.value = res.mapping;
    message.value = "";
    review.value = undefined;
  });
}
const templateEdit = ref<Partial<Template>>();
const versions = ref<Template[]>([]);
function editTemplate(x?: Template) {
  templateEdit.value = x
    ? { ...x }
    : {
        name: "",
        description: "",
        kind: kind.value,
        subject: payload.value.subject,
        html: payload.value.html,
      };
  versions.value = [];
}
async function saveTemplate() {
  await run(async () => {
    const x = templateEdit.value;
    if (!x?.name?.trim() || !x.subject?.trim())
      throw Error(t("名称与主题必填", "Name and subject required"));
    const fields = [
      ...new Set(
        Array.from(
          ((x.subject || "") + " " + (x.html || "")).matchAll(
            /{{\s*([^{}]+?)\s*}}/g,
          ),
        ).map((m) => m[1]!.trim()),
      ),
    ];
    await api(
      x.id ? "/templates/" + idPath(x.id) : "/templates",
      x.id ? "PUT" : "POST",
      {
        name: x.name,
        description: x.description,
        kind: x.kind,
        subject: x.subject,
        html: x.html,
        fields,
      },
    );
    templateEdit.value = undefined;
    await loadPage();
    success.value = t("模板已保存", "Template saved");
  });
}
const deleteRequest = ref<{ path: string; name: string }>();
async function remove() {
  await run(async () => {
    if (!deleteRequest.value) return;
    await api(deleteRequest.value.path, "DELETE");
    deleteRequest.value = undefined;
    await loadPage();
    success.value = t("已删除", "Deleted");
  });
}
const keyName = ref("");
const oneTimeKey = ref("");
const endpoint = location.origin + "/mcp";
const mcpConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        omnimail: {
          url: endpoint,
          headers: { Authorization: "Bearer <YOUR_API_KEY>" },
        },
      },
    },
    null,
    2,
  ),
);
async function createKey() {
  await run(async () => {
    const x = await api<{ id: string; key: string }>("/mcp/keys", "POST", {
      name: keyName.value,
    });
    oneTimeKey.value = x.key;
    keyName.value = "";
    await loadPage();
  });
}
const poll = setInterval(() => {
  if (
    detail.value &&
    ["queued", "running"].includes(detail.value.status) &&
    !busy.value
  )
    void run(async () => {
      detail.value = await api<Task>("/tasks/" + idPath(detail.value!.id));
    });
}, 3000);
onUnmounted(() => clearInterval(poll));
onMounted(status);
const navigator = window.navigator;
const placeholderHint = computed(() =>
  t("支持双花括号动态字段", "Supports double-brace placeholders"),
);
const fieldLabel = (field: string) =>
  (
    ({
      to: t("收件人", "To"),
      cc: t("抄送", "CC"),
      bcc: t("密送", "BCC"),
      requiredAttendees: t("必需参与者", "Required attendees"),
      optionalAttendees: t("可选参与者", "Optional attendees"),
      start: t("开始 · 北京时间", "Start · Beijing time"),
      end: t("结束 · 北京时间", "End · Beijing time"),
      location: t("地点", "Location"),
    }) as Record<string, string>
  )[field];
</script>
<template>
  <div v-if="!auth?.authenticated" class="auth page-enter">
    <div class="brand mb-8"><ArrowUpRight />OmniMail</div>
    <Card class="panel"
      ><div class="eyebrow">SECURE WORKSPACE</div>
      <h1>
        {{
          auth?.needsSetup
            ? t("初始化工作空间", "Initialize workspace")
            : t("欢迎回来", "Welcome back")
        }}
      </h1>
      <p class="muted">
        {{
          t(
            "用 Passkey 安全登录，无需密码。",
            "Sign in securely with a passkey. No password required.",
          )
        }}
      </p>
      <Button
        variant="ghost"
        @click="language = language === 'en' ? 'zh' : 'en'"
        >中文 / English</Button
      >
      <p v-if="loading" role="status">{{ t("正在连接…", "Connecting…") }}</p>
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <Button
        v-if="!auth"
        class="mt-4"
        :disabled="loading || busy"
        @click="status"
        >{{ t("重新连接", "Reconnect") }}</Button
      ><template v-if="auth"
        ><Button
          v-if="!auth.needsSetup"
          class="w-full mt-4"
          :disabled="busy"
          @click="login"
          >{{ t("使用 Passkey 登录", "Sign in with passkey") }}</Button
        >
        <form v-if="auth.needsSetup" @submit.prevent="register">
          <label class="field"
            ><span>{{ t("Passkey 名称", "Passkey name") }}</span
            ><Input v-model="name" required autocomplete="username" /></label
          ><label v-if="auth.needsSetup" class="field"
            ><span>{{
              t(
                "初始化令牌（由服务器提供）",
                "Setup token (provided by server)",
              )
            }}</span
            ><Input
              v-model="setupToken"
              type="password"
              autocomplete="off" /></label
          ><Button
            class="w-full mt-4"
            variant="outline"
            :disabled="busy || !name.trim()"
            >{{
              busy
                ? t("处理中…", "Working…")
                : t("注册 Passkey", "Register passkey")
            }}</Button
          >
        </form></template
      >
      <p class="muted text-xs">
        {{
          t(
            "需要 HTTPS 或 localhost，以及支持 WebAuthn 的设备。",
            "Requires HTTPS or localhost and a WebAuthn-capable device.",
          )
        }}
      </p></Card
    >
  </div>
  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand"><ArrowUpRight />OmniMail</div>
      <nav :aria-label="t('主导航', 'Main navigation')">
        <button
          v-for="item in pages"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          @click="page = item.id"
        >
          <component :is="item.icon" :size="20" />{{ item.name }}
        </button>
      </nav>
      <div class="footer">
        {{ t("Passkey 安全会话", "Passkey secured session") }}<br />{{
          t("AI 仅准备草稿，执行需确认。", "AI drafts. You confirm execution.")
        }}
      </div>
    </aside>
    <main class="min-w-0">
      <header class="topbar">
        <div>
          <span class="mobile-brand">OmniMail / </span
          ><span class="muted">{{ t("工作空间", "Workspace") }} / </span
          >{{ pages.find((x) => x.id === page)?.name }}
        </div>
        <div class="row">
          <Button
            variant="ghost"
            @click="language = language === 'en' ? 'zh' : 'en'"
            >{{ language === "en" ? "中文" : "EN" }}</Button
          ><Button
            variant="outline"
            :disabled="busy"
            @click="
              run(async () => {
                await api('/auth/logout', 'POST', {});
                auth = undefined;
                await status();
              })
            "
            >{{ t("退出", "Sign out") }}</Button
          >
        </div>
      </header>
      <div class="content">
        <div v-if="error" class="notice error mb-4" role="alert">
          {{ error }}
          <Button variant="ghost" :disabled="busy" @click="run(loadPage)">{{
            t("重试", "Retry")
          }}</Button>
        </div>
        <div v-if="success" class="notice success mb-4" role="status">
          {{ success }}
        </div>
        <div v-if="loading" class="notice mb-4" role="status">
          {{ t("正在加载…", "Loading…") }}
        </div>
        <section v-if="page === 'dashboard'" class="page-enter">
          <div class="heading">
            <div class="eyebrow">LESS BUSYWORK. MORE IMPACT.</div>
            <h1>
              {{
                t(
                  "让每封邮件，恰到好处。",
                  "Thoughtful messages. Less busywork.",
                )
              }}
            </h1>
            <p class="muted">
              {{
                t(
                  "准备、预览、确认。每一步都可追溯。",
                  "Prepare, preview, confirm. Every step is traceable.",
                )
              }}
            </p>
          </div>
          <div class="stats">
            <Card
              v-for="metric in [
                {
                  key: 'tasks',
                  label: t('任务总数', 'Total tasks'),
                },
                { key: 'templates', label: t('可用模板', 'Templates') },
                {
                  key: 'accepted',
                  label: t('接口已接收', 'Interface accepted'),
                },
                { key: 'failed', label: t('失败', 'Failed') },
              ]"
              :key="metric.key"
              class="stat"
              ><small>{{ metric.label }}</small
              ><strong>{{ stats?.[metric.key] ?? "—" }}</strong></Card
            >
          </div>
          <div class="workspace">
            <Card class="panel"
              ><div class="row between">
                <h2>{{ t("准备任务", "Prepare a task") }}</h2>
                <Tabs :model-value="kind" @update:model-value="changeKind"
                  ><TabsList
                    ><TabsTrigger value="email">{{
                      t("邮件", "Email")
                    }}</TabsTrigger
                    ><TabsTrigger value="event">{{
                      t("日程", "Event")
                    }}</TabsTrigger></TabsList
                  ></Tabs
                >
              </div>
              <label class="field"
                ><span>{{ t("使用模板", "Use template") }}</span
                ><select v-model="templateId" @change="applyTemplate">
                  <option value="">{{ t("不使用模板", "No template") }}</option>
                  <option v-for="x in templates" :key="x.id" :value="x.id">
                    {{ x.name }} · v{{ x.version }}
                  </option>
                </select></label
              >
              <div class="form-grid">
                <label
                  v-for="field in kind === 'email'
                    ? ['to', 'cc', 'bcc']
                    : [
                        'requiredAttendees',
                        'optionalAttendees',
                        'start',
                        'end',
                        'location',
                      ]"
                  :key="field"
                  class="field"
                  :class="{ full: field === 'to' }"
                  ><span>{{ fieldLabel(field) }}</span
                  ><Input
                    v-model="payload[field]"
                    :type="
                      ['start', 'end'].includes(field)
                        ? 'datetime-local'
                        : 'text'
                    " /></label
                ><label class="field full"
                  ><span
                    >{{ t("主题", "Subject") }} · {{ placeholderHint }}</span
                  ><Input v-model="payload.subject"
                /></label>
              </div>
              <div class="field">
                <span>{{ t("HTML 正文", "HTML body") }}</span
                ><HtmlEditor v-model="payload.html" :t="t" />
              </div>
              <div class="actions">
                <Button
                  variant="outline"
                  :disabled="busy"
                  @click="editTemplate()"
                  >{{ t("保存为模板", "Save as template") }}</Button
                ><Button :disabled="busy" @click="createDraft">{{
                  busy
                    ? t("处理中…", "Working…")
                    : t("预览并确认", "Review & confirm")
                }}</Button>
              </div>
              <p class="muted text-xs">
                {{
                  t(
                    "测试发送也使用此流程。收件人必须手动填写；不会自动发送。",
                    "Tests use this same flow. Enter recipients yourself; nothing sends automatically.",
                  )
                }}
              </p></Card
            >
            <div class="stack">
              <Card class="panel"
                ><h2 class="text-primary">
                  ✧ {{ t("AI 草稿助手", "AI drafting assistant") }}
                </h2>
                <p class="muted text-xs">
                  {{
                    t(
                      "只修改草稿；未配置提供商时将显示 API 错误。",
                      "Only edits drafts; API errors are shown if no provider is configured.",
                    )
                  }}
                </p>
                <div class="chat">
                  <div v-if="!conversation.length" class="empty">
                    {{
                      t(
                        "描述你的想法，AI 帮你准备。",
                        "Describe your intent to prepare a draft.",
                      )
                    }}
                  </div>
                  <div
                    v-for="(x, i) in conversation"
                    :key="i"
                    class="bubble"
                    :class="x.role"
                  >
                    <small>{{
                      x.role === "user" ? t("你", "You") : "OmniMail"
                    }}</small>
                    <div>{{ x.content }}</div>
                  </div>
                </div>
                <form @submit.prevent="ask">
                  <label class="field"
                    ><span>{{ t("你的指令", "Your instruction") }}</span
                    ><Textarea v-model="message" rows="3" /></label
                  ><Button class="mt-3" :disabled="busy || !message.trim()">{{
                    t("更新草稿", "Update draft")
                  }}</Button>
                </form>
                <pre v-if="mapping">{{ mapping }}</pre>
              </Card>
              <Card class="panel"
                ><h2>{{ t("批量数据", "Batch data") }}</h2>
                <label class="field"
                  ><span>{{ t("导入 CSV / Excel", "Import CSV / Excel") }}</span
                  ><input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    :disabled="busy"
                    @change="importFile"
                /></label>
                <p v-if="!rows.length" class="muted">
                  {{
                    t(
                      "未导入数据。默认单次任务。",
                      "No imported rows. Single task by default.",
                    )
                  }}
                </p>
                <template v-else
                  ><p>
                    {{ fileName }} · {{ rows.length }} {{ t("行", "rows") }}
                  </p>
                  <div class="row">
                    <span
                      v-for="column in columns"
                      :key="column"
                      class="badge"
                      >{{ column }}</span
                    >
                  </div>
                  <p class="muted text-xs">
                    {{
                      t(
                        "AI 样本值已脱敏；服务器替换占位符。",
                        "AI sample values are redacted; server substitutes placeholders.",
                      )
                    }}
                  </p>
                  <Button
                    variant="outline"
                    @click="
                      rows = [];
                      columns = [];
                      fileName = '';
                    "
                    >{{ t("清除数据", "Clear data") }}</Button
                  ></template
                ></Card
              >
            </div>
          </div>
        </section>
        <section v-if="page === 'history'" class="page-enter">
          <div class="heading">
            <h1>{{ t("任务历史", "Task history") }}</h1>
            <p class="muted">
              {{
                t(
                  "接口已接收不代表实际发送成功。不确定状态请人工核实，避免重复发送。",
                  "Accepted does not mean delivered. Verify uncertain outcomes before retrying.",
                )
              }}
            </p>
          </div>
          <Card class="panel"
            ><label class="field"
              ><span>{{ t("状态筛选", "Filter status") }}</span
              ><select v-model="filter">
                <option value="all">{{ t("所有状态", "All statuses") }}</option>
                <option v-for="s in statuses" :key="s" :value="s">
                  {{ stateLabel(s) }}
                </option>
              </select></label
            >
            <div class="form-grid">
              <label class="field"
                ><span>{{ t("模板筛选", "Template") }}</span
                ><select v-model="templateFilter">
                  <option value="all">
                    {{ t("全部模板", "All templates") }}
                  </option>
                  <option v-for="x in templates" :key="x.id" :value="x.id">
                    {{ x.name }}
                  </option>
                </select></label
              >
              <label class="field"
                ><span>{{ t("调用来源", "Source") }}</span
                ><select v-model="sourceFilter">
                  <option value="all">
                    {{ t("全部来源", "All sources") }}
                  </option>
                  <option value="web">Web</option>
                  <option value="mcp">MCP</option>
                </select></label
              >
              <label class="field"
                ><span>{{ t("开始日期", "From date") }}</span
                ><Input v-model="fromDate" type="date"
              /></label>
              <label class="field"
                ><span>{{ t("结束日期", "To date") }}</span
                ><Input v-model="toDate" type="date"
              /></label>
            </div>
            <div v-if="!filtered.length && !loading" class="empty">
              {{ t("暂无任务", "No tasks yet") }}
            </div>
            <div v-for="x in filtered" :key="x.id" class="record row between">
              <div>
                <strong>{{ x.summary || x.id }}</strong>
                <p class="muted text-xs">
                  {{ x.kind }} · {{ x.source }} · {{ x.createdAt }}
                </p>
                <span class="badge">{{ stateLabel(x.status) }}</span> ·
                {{ t("总数", "Total") }} {{ x.total }} /
                {{ t("接收", "Accepted") }} {{ x.accepted }} /
                {{ t("失败", "Failed") }} {{ x.failed }}
              </div>
              <Button variant="outline" :disabled="busy" @click="openTask(x)">{{
                t("查看详情", "Details")
              }}</Button>
            </div></Card
          ><Card v-if="detail" class="panel mt-6"
            ><div class="row between">
              <h2>{{ detail.summary || detail.id }}</h2>
              <span class="badge">{{ stateLabel(detail.status) }}</span>
            </div>
            <p v-if="detail.template" class="muted">
              {{ t("使用模板", "Template") }}: {{ detail.template.name }} · v{{
                detail.template.version
              }}
            </p>
            <pre>{{ detail.payload }}</pre>
            <p>
              {{ t("接口调用数", "Interface calls") }}: {{ detail.total }} ·
              {{ t("已接收", "Accepted") }} {{ detail.accepted }} ·
              {{ t("失败", "Failed") }}
              {{ detail.failed }}
            </p>
            <div v-for="x in detail.items" :key="x.id" class="record">
              <span class="badge">{{ stateLabel(x.status) }}</span>
              <pre>{{ x.payload }}</pre>
              <p v-if="x.error" class="notice error">{{ x.error }}</p>
            </div>
            <div v-for="(x, i) in detail.conversation" :key="i" class="bubble">
              {{ x.role }}: {{ x.content }}
            </div>
            <div class="actions">
              <Button
                variant="outline"
                :disabled="busy"
                @click="openTask(detail)"
                >{{ t("刷新", "Refresh") }}</Button
              ><Button
                v-if="detail.status === 'draft'"
                :disabled="busy"
                @click="
                  review = detail;
                  reviewOpen = true;
                "
                >{{ t("预览并确认", "Review & confirm") }}</Button
              ><Button
                v-if="['draft', 'queued', 'running'].includes(detail.status)"
                variant="outline"
                :disabled="busy"
                @click="cancelTask(detail)"
                >{{ t("取消任务", "Cancel task") }}</Button
              >
            </div></Card
          >
        </section>
        <section v-if="page === 'templates'" class="page-enter">
          <div class="heading row between">
            <div>
              <h1>{{ t("模板管理", "Templates") }}</h1>
              <p class="muted">{{ placeholderHint }}</p>
            </div>
            <Button @click="editTemplate()">{{
              t("新建模板", "New template")
            }}</Button>
          </div>
          <Card class="panel"
            ><div v-if="!templates.length && !loading" class="empty">
              {{
                t(
                  "暂无模板，创建你的第一个模板。",
                  "No templates. Create your first one.",
                )
              }}
            </div>
            <div v-for="x in templates" :key="x.id" class="record">
              <div class="row between">
                <div>
                  <strong>{{ x.name }}</strong>
                  <span class="badge">{{ x.kind }} · v{{ x.version }}</span>
                  <p class="muted">{{ x.description }}</p>
                  <p>{{ x.subject }}</p>
                </div>
                <div class="row">
                  <Button variant="outline" @click="editTemplate(x)">{{
                    t("编辑", "Edit")
                  }}</Button
                  ><Button
                    variant="ghost"
                    @click="
                      deleteRequest = {
                        path: '/templates/' + idPath(x.id),
                        name: x.name,
                      }
                    "
                    >{{ t("删除", "Delete") }}</Button
                  >
                </div>
              </div>
            </div></Card
          >
        </section>
        <SettingsPage
          v-if="page === 'settings'"
          :t="t"
          :language="language"
          @language="language = $event"
        />
        <section v-if="page === 'mcp'" class="page-enter">
          <div class="heading">
            <h1>{{ t("MCP 服务", "MCP service") }}</h1>
            <p class="muted">
              {{
                t(
                  "让兼容 MCP 的客户端安全调用 OmniMail。",
                  "Connect MCP-compatible clients to OmniMail.",
                )
              }}
            </p>
          </div>
          <div class="notice mb-6">
            {{
              t(
                "注意：MCP 的 send_email / create_event 使用 Bearer API key，不需要人工确认。请只向可信客户端授权。",
                "Warning: MCP send_email / create_event use Bearer API keys without human confirmation. Authorize trusted clients only.",
              )
            }}
          </div>
          <div class="workspace">
            <Card class="panel"
              ><h2>{{ t("API 密钥", "API keys") }}</h2>
              <form @submit.prevent="createKey">
                <label class="field"
                  ><span>{{ t("密钥名称", "Key name") }}</span
                  ><Input v-model="keyName" required /></label
                ><Button class="mt-4" :disabled="busy || !keyName.trim()">{{
                  t("创建密钥", "Create key")
                }}</Button>
              </form>
              <div v-if="oneTimeKey" class="notice mt-4">
                <strong>{{
                  t(
                    "仅显示一次，请安全保存。",
                    "Shown once. Store it securely.",
                  )
                }}</strong>
                <pre>{{ oneTimeKey }}</pre>
                <Button
                  variant="outline"
                  @click="
                    run(async () => {
                      await navigator.clipboard.writeText(oneTimeKey);
                      success = t('已复制', 'Copied');
                    })
                  "
                  >{{ t("复制", "Copy") }}</Button
                >
                <Button variant="ghost" @click="oneTimeKey = ''">{{
                  t("我已保存，隐藏", "Saved; hide")
                }}</Button>
              </div>
              <div v-if="!keys.length && !loading" class="empty">
                {{ t("暂无密钥", "No keys") }}
              </div>
              <div v-for="x in keys" :key="x.id" class="record row between">
                <div>
                  {{ x.name }}
                  <p class="muted text-xs">
                    {{ x.prefix }}… · {{ x.createdAt }}
                  </p>
                </div>
                <Button
                  variant="outline"
                  @click="
                    deleteRequest = {
                      path: '/mcp/keys/' + idPath(x.id),
                      name: x.name,
                    }
                  "
                  >{{ t("撤销", "Revoke") }}</Button
                >
              </div></Card
            ><Card class="panel"
              ><h2>{{ t("客户端配置", "Client configuration") }}</h2>
              <pre>{{ mcpConfig }}</pre>
              <p class="muted">
                {{
                  t(
                    "将占位符替换成刚创建的密钥。",
                    "Replace the placeholder with your newly created key.",
                  )
                }}
              </p>
              <p>send_email · create_event · get_task · list_templates</p>
              <p class="muted">
                {{
                  t(
                    "邮件 / 日程调用不会在本页执行。",
                    "No email or calendar calls execute on this page.",
                  )
                }}
              </p></Card
            >
          </div>
        </section>
      </div>
    </main>
  </div>
  <Dialog v-model:open="reviewOpen"
    ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
      ><DialogHeader
        ><DialogTitle>{{
          t("执行前确认", "Confirm before execution")
        }}</DialogTitle
        ><DialogDescription>{{
          t(
            "确认收件人、数量及内容。此操作会调用邮件或日程接口。接口接收不等于发送成功。",
            "Review recipients, count and content. This invokes the email/calendar interface. Accepted does not mean delivered.",
          )
        }}</DialogDescription></DialogHeader
      ><template v-if="review"
        ><p>
          {{ review.kind }} · {{ t("接口调用数", "Interface calls") }}:
          {{ review.total }} ·
          {{
            t(
              "收件地址数（含抄送/密送）",
              "Recipient addresses (including CC/BCC)",
            )
          }}: {{ recipientCount(review) }}
        </p>
        <pre>{{ review.payload }}</pre>
        <div v-for="x in review.items" :key="x.id" class="record">
          <pre>{{ x.payload }}</pre>
          <p v-if="x.error" class="notice error">{{ x.error }}</p>
        </div>
        <div v-if="error" class="notice error" role="alert">{{ error }}</div>
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="reviewOpen = false"
            >{{ t("保留草稿", "Keep draft") }}</Button
          ><Button
            :disabled="busy || review.status !== 'draft'"
            @click="confirm"
            >{{ t("确认执行", "Confirm execution") }}</Button
          >
        </div></template
      ></DialogContent
    ></Dialog
  >
  <Dialog
    :open="!!templateEdit"
    @update:open="!$event && (templateEdit = undefined)"
    ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
      ><DialogHeader
        ><DialogTitle>{{ t("编辑模板", "Edit template") }}</DialogTitle
        ><DialogDescription>{{
          t(
            "保存主题和 HTML 占位符，可回滚历史版本。",
            "Save subject and HTML placeholders; roll back previous versions.",
          )
        }}</DialogDescription></DialogHeader
      >
      <form v-if="templateEdit" @submit.prevent="saveTemplate">
        <label class="field"
          ><span>{{ t("名称", "Name") }}</span
          ><Input v-model="templateEdit.name" required /></label
        ><label class="field"
          ><span>{{ t("说明", "Description") }}</span
          ><Input v-model="templateEdit.description" /></label
        ><label class="field"
          ><span>{{ t("类型", "Kind") }}</span
          ><select v-model="templateEdit.kind">
            <option value="email">{{ t("邮件", "Email") }}</option>
            <option value="event">{{ t("日程", "Event") }}</option>
          </select></label
        ><label class="field"
          ><span>{{ t("主题", "Subject") }}</span
          ><Input v-model="templateEdit.subject" required /></label
        ><HtmlEditor v-model="templateEdit.html!" :t="t" />
        <div v-if="error" class="notice error">{{ error }}</div>
        <div class="actions">
          <Button
            v-if="templateEdit.id"
            type="button"
            variant="outline"
            :disabled="busy"
            @click="
              run(async () => {
                versions = await api<Template[]>(
                  '/templates/' + idPath(templateEdit!.id!) + '/versions',
                );
              })
            "
            >{{ t("历史版本", "Versions") }}</Button
          ><Button :disabled="busy">{{ t("保存", "Save") }}</Button>
        </div>
        <div v-for="v in versions" :key="v.version" class="record row between">
          <span>v{{ v.version }} · {{ v.subject }}</span
          ><Button
            type="button"
            variant="outline"
            :disabled="busy"
            @click="
              run(async () => {
                await api(
                  '/templates/' + idPath(templateEdit!.id!) + '/rollback',
                  'POST',
                  { version: v.version },
                );
                templateEdit = undefined;
                await loadPage();
                success = t('已回滚', 'Rolled back');
              })
            "
            >{{ t("回滚", "Roll back") }}</Button
          >
        </div>
      </form></DialogContent
    ></Dialog
  >
  <Dialog
    :open="!!deleteRequest"
    @update:open="!$event && (deleteRequest = undefined)"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>{{
          t("确认删除 / 撤销", "Confirm deletion / revocation")
        }}</DialogTitle
        ><DialogDescription
          >{{ deleteRequest?.name }} ·
          {{
            t("此操作不可撤销。", "This cannot be undone.")
          }}</DialogDescription
        ></DialogHeader
      >
      <p v-if="error" class="notice error">{{ error }}</p>
      <div class="actions">
        <Button variant="outline" @click="deleteRequest = undefined">{{
          t("返回", "Back")
        }}</Button
        ><Button variant="destructive" :disabled="busy" @click="remove">{{
          t("确认删除", "Confirm delete")
        }}</Button>
      </div></DialogContent
    ></Dialog
  >
</template>
