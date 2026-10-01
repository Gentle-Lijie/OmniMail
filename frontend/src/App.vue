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
  Moon,
  Sun,
  ShieldCheck,
  LogOut,
  RefreshCw,
  Plus,
  Copy,
  KeyRound,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import WorkspaceView from "@/components/WorkspaceView.vue";
import TaskContent from "@/components/TaskContent.vue";
import AppSelect from "@/components/ui/AppSelect.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import HtmlEditor from "@/components/HtmlEditor.vue";
import { fieldsIn } from "@/lib/mailMerge";
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
const workspaceBusy = ref(false);
const humanConfirmed = ref(false);
const dark = ref(false);
try {
  dark.value = localStorage.getItem("omnimail-theme") === "dark";
} catch {}
watch(
  dark,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
    try {
      localStorage.setItem("omnimail-theme", value ? "dark" : "light");
    } catch {}
  },
  { immediate: true },
);

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
  error.value = "";
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
const keys = ref<Key[]>([]);
async function loadPage() {
  loading.value = true;
  try {
    if (["dashboard", "history", "templates"].includes(page.value)) {
      const [loadedTemplates, loadedTasks] = await Promise.all([
        api<Template[]>("/templates"),
        api<Task[]>("/tasks"),
      ]);
      templates.value = loadedTemplates;
      tasks.value = loadedTasks;
    } else if (page.value === "mcp") keys.value = await api<Key[]>("/mcp/keys");
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
const review = ref<Task>();
const reviewOpen = ref(false);
watch(reviewOpen, () => {
  humanConfirmed.value = false;
});
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
const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(language.value === "en" ? "en-GB" : "zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(date)
    : value;
};
const kindLabel = (value: Kind) =>
  value === "email" ? t("邮件", "Email") : t("日程", "Event");
const stateLabel = (s: string) =>
  t(
    (
      {
        draft: "草稿",
        pending: "待执行",
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
async function confirm() {
  await run(async () => {
    if (
      !review.value ||
      !humanConfirmed.value ||
      review.value.status !== "draft"
    )
      return;
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
    <aside class="sidebar rail">
      <div class="brand rail-brand" aria-label="OmniMail"><Mail /></div>
      <nav :aria-label="t('主导航', 'Main navigation')">
        <Button
          variant="ghost"
          v-for="item in pages"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :disabled="busy || workspaceBusy"
          :title="item.name"
          @click="page = item.id"
        >
          <component :is="item.icon" :size="20" /><span>{{ item.name }}</span>
        </Button>
      </nav>
      <div class="rail-footer">
        <Button
          variant="ghost"
          size="icon"
          :aria-label="t('切换明暗主题', 'Toggle theme')"
          :title="t('切换明暗主题', 'Toggle theme')"
          @click="dark = !dark"
          ><Sun v-if="dark" /><Moon v-else
        /></Button>
        <div
          class="session-avatar"
          :title="t('Passkey 安全会话', 'Passkey secured session')"
        >
          <ShieldCheck :size="18" />
        </div>
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
            variant="ghost"
            :aria-label="t('退出', 'Sign out')"
            :disabled="busy || workspaceBusy"
            @click="
              run(async () => {
                await api('/auth/logout', 'POST', {});
                auth = undefined;
                await status();
              })
            "
            ><LogOut :size="15" /><span class="signout-label">{{
              t("退出", "Sign out")
            }}</span></Button
          >
        </div>
      </header>
      <div class="content" :class="{ 'desk-content': page === 'dashboard' }">
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
        <WorkspaceView
          v-show="page === 'dashboard'"
          :templates="templates"
          :tasks="tasks"
          :t="t"
          :dark="dark"
          :visible="page === 'dashboard'"
          :locked="busy"
          @expired="status"
          @busy="workspaceBusy = $event"
          @review="
            review = $event;
            reviewOpen = true;
          "
          @saved="run(loadPage)"
          @settings="page = 'settings'"
          @template="
            (draftKind, draftPayload) => {
              kind = draftKind;
              payload = draftPayload;
              editTemplate();
            }
          "
        />
        <section v-if="page === 'history'" class="page-enter">
          <div class="heading row between">
            <div>
              <h1>{{ t("执行历史", "Execution history") }}</h1>
              <p class="muted">
                {{
                  t(
                    "接口已接收不代表实际发送成功。不确定状态请人工核实，避免重复发送。",
                    "Accepted does not mean delivered. Verify uncertain outcomes before retrying.",
                  )
                }}
              </p>
            </div>
            <Button variant="outline" :disabled="busy" @click="run(loadPage)"
              ><RefreshCw />{{ t("刷新", "Refresh") }}</Button
            >
          </div>
          <Card class="panel"
            ><label class="field"
              ><span>{{ t("状态筛选", "Filter status") }}</span
              ><AppSelect
                v-model="filter"
                :options="[
                  { value: 'all', label: t('所有状态', 'All statuses') },
                  ...statuses.map((status) => ({
                    value: status,
                    label: stateLabel(status),
                  })),
                ]"
            /></label>
            <div class="form-grid">
              <label class="field"
                ><span>{{ t("模板筛选", "Template") }}</span
                ><AppSelect
                  v-model="templateFilter"
                  :options="[
                    { value: 'all', label: t('全部模板', 'All templates') },
                    ...templates.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]"
              /></label>
              <label class="field"
                ><span>{{ t("调用来源", "Source") }}</span
                ><AppSelect
                  v-model="sourceFilter"
                  :options="[
                    { value: 'all', label: t('全部来源', 'All sources') },
                    { value: 'web', label: 'Web' },
                    { value: 'mcp', label: 'MCP' },
                  ]"
              /></label>
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
                  {{ kindLabel(x.kind) }} ·
                  {{ x.source.startsWith("mcp:") ? "MCP" : "Web" }} ·
                  {{ formatDate(x.createdAt) }}
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
            <TaskContent :key="detail.id" :task="detail" :t="t" />
            <p>
              {{ t("接口调用数", "Interface calls") }}: {{ detail.total }} ·
              {{ t("已接收", "Accepted") }} {{ detail.accepted }} ·
              {{ t("失败", "Failed") }}
              {{ detail.failed }}
            </p>
            <div class="merge-table-scroll">
              <table class="data-table task-results">
                <caption class="sr-only">
                  {{
                    t("逐条执行结果", "Per-item results")
                  }}
                </caption>
                <thead>
                  <tr>
                    <th>
                      {{ t("收件人 / 参会者", "Recipients / attendees") }}
                    </th>
                    <th>{{ t("状态", "Status") }}</th>
                    <th>{{ t("结果说明", "Result details") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in detail.items" :key="item.id">
                    <td>
                      {{
                        item.payload.to ||
                        item.payload.requiredAttendees ||
                        t("无", "None")
                      }}
                    </td>
                    <td>
                      <span class="badge">{{ stateLabel(item.status) }}</span>
                    </td>
                    <td>
                      {{ item.error || t("无附加错误", "No additional error") }}
                    </td>
                  </tr>
                </tbody>
              </table>
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
            <Button @click="editTemplate()"
              ><Plus />{{ t("新建模板", "New template") }}</Button
            >
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
                  <span class="badge"
                    >{{ kindLabel(x.kind) }} · v{{ x.version }}</span
                  >
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
              ><h2 class="icon-label">
                <KeyRound :size="18" />{{ t("API 密钥", "API keys") }}
              </h2>
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
                    {{ x.prefix }}… · {{ formatDate(x.createdAt) }}
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
          {{
            review.kind === "email" ? t("邮件", "Email") : t("日程", "Event")
          }}
          · {{ t("接口调用数", "Interface calls") }}: {{ review.total }} ·
          {{
            t(
              "收件地址数（含抄送/密送）",
              "Recipient addresses (including CC/BCC)",
            )
          }}: {{ recipientCount(review) }}
        </p>
        <TaskContent :key="review.id" :task="review" :t="t" /><label
          class="confirm-check"
          ><AppCheckbox
            v-model="humanConfirmed"
            :disabled="busy || review.status !== 'draft'"
          /><span>{{
            t(
              "我已审核收件人及整批内容，同意执行。",
              "I reviewed recipients and the entire batch and authorize execution.",
            )
          }}</span></label
        >
        <div v-if="error" class="notice error" role="alert">{{ error }}</div>
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="reviewOpen = false"
            >{{ t("保留草稿", "Keep draft") }}</Button
          ><Button
            :disabled="busy || !humanConfirmed || review.status !== 'draft'"
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
          ><AppSelect
            v-model="templateEdit.kind"
            :options="[
              { value: 'email', label: t('邮件', 'Email') },
              { value: 'event', label: t('日程', 'Event') },
            ]" /></label
        ><label class="field"
          ><span>{{ t("主题", "Subject") }}</span
          ><Input v-model="templateEdit.subject" required /></label
        ><HtmlEditor
          v-model="templateEdit.html!"
          :t="t"
          :dark="dark"
          :disabled="busy"
          :fields="
            fieldsIn({
              subject: templateEdit.subject || '',
              html: templateEdit.html || '',
            })
          "
        />
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
