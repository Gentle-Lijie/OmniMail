<script setup lang="ts">
import { ref, onMounted } from "vue";
import { startRegistration } from "@simplewebauthn/browser";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, idPath, type Settings, type Provider, type Key } from "@/lib/api";
const props = defineProps<{
  t: (zh: string, en: string) => string;
  language: string;
}>();
const emit = defineEmits<{ language: [string] }>();
const settings = ref<Settings>();
const passkeys = ref<Key[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const success = ref("");
const mailUrl = ref("");
const eventUrl = ref("");
const newPasskey = ref("");
const language = ref(props.language);
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function load() {
  loading.value = true;
  try {
    const [s, p] = await Promise.all([
      api<Settings>("/settings"),
      api<Key[]>("/passkeys"),
    ]);
    settings.value = s;
    passkeys.value = p;
    language.value = s.language || props.language;
    emit("language", language.value);
  } finally {
    loading.value = false;
  }
}
async function save() {
  await run(async () => {
    if (!settings.value) return;
    const s = settings.value;
    await api("/settings", "PUT", {
      registrationEnabled: s.registrationEnabled,
      language: language.value,
      rateLimitMs: Number(s.rateLimitMs),
      defaultProviderId: s.defaultProviderId,
      prompt: s.prompt,
      ...(mailUrl.value ? { mailWebhookUrl: mailUrl.value } : {}),
      ...(eventUrl.value ? { eventWebhookUrl: eventUrl.value } : {}),
    });
    mailUrl.value = "";
    eventUrl.value = "";
    await load();
    success.value = props.t("设置已保存", "Settings saved");
  });
}
const editing = ref<Partial<Provider> & { apiKey?: string }>();
const headers = ref("");
const models = ref<{ id: string; name: string }[]>([]);
const testResult = ref("");
function edit(p?: Provider) {
  editing.value = p
    ? { ...p }
    : {
        name: "",
        protocol: "openai-responses",
        baseUrl: "",
        model: "",
        modelsUrl: "",
        apiKey: "",
      };
  headers.value = JSON.stringify(p?.headers || {}, null, 2);
  models.value = [];
  testResult.value = "";
}
async function saveProvider() {
  await run(async () => {
    if (!editing.value) return;
    const p = editing.value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(headers.value || "{}");
    } catch {
      throw Error(
        props.t("Headers 必须为 JSON 对象", "Headers must be a JSON object"),
      );
    }
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      Object.values(parsed).some((v) => typeof v !== "string")
    )
      throw Error(
        props.t("Headers 的值必须为字符串", "Header values must be strings"),
      );
    const body = {
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      model: p.model,
      modelsUrl: p.modelsUrl || undefined,
      headers: parsed,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
    };
    await api(
      p.id ? "/providers/" + idPath(p.id) : "/providers",
      p.id ? "PUT" : "POST",
      body,
    );
    editing.value = undefined;
    await load();
    success.value = props.t("提供商已保存", "Provider saved");
  });
}
async function fetchModels(p: Provider) {
  await run(async () => {
    models.value = (
      await api<{ models: { id: string; name: string }[] }>(
        "/providers/" + idPath(p.id) + "/models",
        "POST",
        {},
      )
    ).models;
  });
}
async function testProvider(p: Provider) {
  await run(async () => {
    const x = await api<{ ok: boolean; latencyMs: number; text: string }>(
      "/providers/" + idPath(p.id) + "/test",
      "POST",
      { model: editing.value?.model || p.model },
    );
    testResult.value = `${x.ok ? props.t("连接成功", "Connection succeeded") : props.t("连接失败", "Connection failed")} · ${x.latencyMs} ms\n${x.text}`;
  });
}
const deleting = ref<{ path: string; name: string }>();
async function remove() {
  await run(async () => {
    if (!deleting.value) return;
    await api(deleting.value.path, "DELETE");
    deleting.value = undefined;
    await load();
    success.value = props.t("已删除", "Deleted");
  });
}
async function addPasskey() {
  await run(async () => {
    const name = newPasskey.value;
    const options = await api<
      Parameters<typeof startRegistration>[0]["optionsJSON"]
    >("/auth/register/options", "POST", { name });
    const response = await startRegistration({ optionsJSON: options });
    await api("/auth/register/verify", "POST", { response, name });
    newPasskey.value = "";
    await load();
    success.value = props.t("Passkey 已添加", "Passkey added");
  });
}
onMounted(() => run(load));
</script>
<template>
  <section class="page-enter">
    <div class="heading">
      <h1>{{ t("设置", "Settings") }}</h1>
      <p class="muted">
        {{
          t(
            "管理接口、AI 提供商与访问安全。",
            "Manage integrations, AI providers and access security.",
          )
        }}
      </p>
    </div>
    <div v-if="loading" class="notice mb-4" role="status">
      {{ t("加载中…", "Loading…") }}
    </div>
    <div v-if="error" class="notice error mb-4" role="alert">
      {{ error }}
      <Button variant="ghost" :disabled="busy" @click="run(load)">{{
        t("重试", "Retry")
      }}</Button>
    </div>
    <div v-if="success" class="notice success mb-4" role="status">
      {{ success }}
    </div>
    <div class="workspace">
      <div class="stack">
        <Card v-if="settings" class="panel"
          ><h2>{{ t("常规与接口", "General & integrations") }}</h2>
          <form @submit.prevent="save">
            <label class="field"
              ><span>{{ t("语言", "Language") }}</span
              ><select v-model="language">
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select></label
            ><label class="field"
              ><span>{{ t("速率间隔（毫秒）", "Rate interval (ms)") }}</span
              ><Input
                v-model="settings.rateLimitMs"
                type="number"
                min="0"
                required /></label
            ><label class="row mt-4"
              ><input
                v-model="settings.registrationEnabled"
                type="checkbox"
              />{{
                t("允许注册新 Passkey", "Allow new passkey registration")
              }}</label
            ><label class="field"
              ><span>{{ t("默认 AI 提供商", "Default AI provider") }}</span
              ><Select v-model="settings.defaultProviderId"
                ><SelectTrigger class="w-full"
                  ><SelectValue
                    :placeholder="
                      t('选择提供商', 'Select provider')
                    " /></SelectTrigger
                ><SelectContent
                  ><SelectItem
                    v-for="p in settings.providers"
                    :key="p.id"
                    :value="p.id"
                    >{{ p.name }}</SelectItem
                  ></SelectContent
                ></Select
              ></label
            >
            <label class="field"
              ><span>{{ t("自定义 AI 指令", "Custom AI instructions") }}</span
              ><Textarea
                v-model="settings.prompt"
                rows="4"
                :placeholder="
                  t(
                    '补充语气、格式和工作规则；不能授予执行权限。',
                    'Tone, format and workspace rules; cannot grant execution permission.',
                  )
                "
            /></label>
            <label class="field"
              ><span>{{
                t(
                  "邮件 Webhook URL（留空保留现值）",
                  "Mail webhook URL (blank keeps existing)",
                )
              }}</span
              ><Input
                v-model="mailUrl"
                type="url"
                autocomplete="off"
              /><small>{{
                settings.mailConfigured
                  ? t("已配置", "Configured")
                  : t("未配置", "Not configured")
              }}</small></label
            ><label class="field"
              ><span>{{
                t(
                  "日程 Webhook URL（留空保留现值）",
                  "Event webhook URL (blank keeps existing)",
                )
              }}</span
              ><Input
                v-model="eventUrl"
                type="url"
                autocomplete="off"
              /><small>{{
                settings.eventConfigured
                  ? t("已配置", "Configured")
                  : t("未配置", "Not configured")
              }}</small></label
            >
            <p class="muted text-xs">
              {{
                t(
                  "不在此处测试邮件或日程。请到工作台手动填写收件人并走完整确认流程。",
                  "No mail/calendar tests here. Enter recipients in Workspace and complete the confirmation flow.",
                )
              }}
            </p>
            <div class="actions">
              <Button :disabled="busy">{{
                t("保存设置", "Save settings")
              }}</Button>
            </div>
          </form></Card
        ><Card class="panel"
          ><div class="row between">
            <h2>{{ t("AI 提供商", "AI providers") }}</h2>
            <Button variant="outline" @click="edit()">{{
              t("添加", "Add")
            }}</Button>
          </div>
          <div v-if="!settings?.providers.length && !loading" class="empty">
            {{
              t(
                "未配置提供商，AI 助手暂不可用。",
                "No providers configured. AI assistant is unavailable.",
              )
            }}
          </div>
          <div v-for="p in settings?.providers" :key="p.id" class="record">
            <strong>{{ p.name }}</strong>
            <p class="muted text-xs">
              {{ p.protocol }} · {{ p.model }}<br />{{ p.baseUrl }}<br />{{
                p.hasApiKey
                  ? t("密钥已配置", "API key configured")
                  : t("无密钥", "No API key")
              }}
            </p>
            <div class="row">
              <Button variant="outline" @click="edit(p)">{{
                t("编辑 / 测试", "Edit / test")
              }}</Button
              ><Button
                variant="ghost"
                @click="
                  deleting = {
                    path: '/providers/' + idPath(p.id),
                    name: p.name,
                  }
                "
                >{{ t("删除", "Delete") }}</Button
              >
            </div>
          </div></Card
        >
      </div>
      <Card class="panel self-start"
        ><h2>{{ t("Passkey 安全", "Passkey security") }}</h2>
        <form @submit.prevent="addPasskey">
          <label class="field"
            ><span>{{ t("新 Passkey 名称", "New passkey name") }}</span
            ><Input
              v-model="newPasskey"
              required
              autocomplete="username" /></label
          ><Button class="mt-4" :disabled="busy || !newPasskey.trim()">{{
            t("添加 Passkey", "Add passkey")
          }}</Button>
        </form>
        <div v-if="!passkeys.length && !loading" class="empty">
          {{ t("暂无 Passkey", "No passkeys") }}
        </div>
        <div v-for="p in passkeys" :key="p.id" class="record row between">
          <div>
            {{ p.name }}
            <p class="muted text-xs">{{ p.createdAt }}</p>
          </div>
          <Button
            variant="outline"
            @click="
              deleting = { path: '/passkeys/' + idPath(p.id), name: p.name }
            "
            >{{ t("删除", "Delete") }}</Button
          >
        </div>
        <p class="muted text-xs">
          {{
            t(
              "删除最后一个 Passkey 可能导致无法登录，服务器会校验操作。",
              "Deleting your last passkey may lock you out; server validation applies.",
            )
          }}
        </p></Card
      >
    </div>
    <Dialog :open="!!editing" @update:open="!$event && (editing = undefined)"
      ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        ><DialogHeader
          ><DialogTitle>{{ t("AI 提供商", "AI provider") }}</DialogTitle
          ><DialogDescription>{{
            t(
              "密钥仅发送至服务器，不保存到浏览器存储。",
              "Keys are sent to the server, never persisted in browser storage.",
            )
          }}</DialogDescription></DialogHeader
        >
        <form v-if="editing" @submit.prevent="saveProvider">
          <label class="field"
            ><span>{{ t("名称", "Name") }}</span
            ><Input v-model="editing.name" required /></label
          ><label class="field"
            ><span>{{ t("协议", "Protocol") }}</span
            ><select v-model="editing.protocol">
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic">Anthropic</option>
            </select></label
          ><label class="field"
            ><span>Base URL</span
            ><Input v-model="editing.baseUrl" type="url" required /></label
          ><label class="field"
            ><span>{{ t("模型", "Model") }}</span
            ><Input v-model="editing.model" required /></label
          ><label class="field"
            ><span>{{
              t("模型列表 URL（可选）", "Models URL (optional)")
            }}</span
            ><Input v-model="editing.modelsUrl" type="url" /></label
          ><label class="field"
            ><span>{{
              t("API key（留空保留）", "API key (blank keeps existing)")
            }}</span
            ><Input
              v-model="editing.apiKey"
              type="password"
              autocomplete="off" /></label
          ><label class="field"
            ><span>{{
              t("自定义 Headers（JSON）", "Custom headers (JSON)")
            }}</span
            ><Textarea v-model="headers" rows="3" spellcheck="false"
          /></label>
          <div v-if="error" class="notice error mt-4">{{ error }}</div>
          <div class="actions">
            <template v-if="editing.id"
              ><Button
                type="button"
                variant="outline"
                :disabled="busy"
                @click="fetchModels(editing as Provider)"
                >{{ t("获取模型", "Fetch models") }}</Button
              ><Button
                type="button"
                variant="outline"
                :disabled="busy"
                @click="testProvider(editing as Provider)"
                >{{ t("测试 AI 连接", "Test AI connection") }}</Button
              ></template
            ><Button :disabled="busy">{{ t("保存", "Save") }}</Button>
          </div>
          <p v-if="editing.id" class="muted text-xs">
            {{
              t(
                "获取和测试使用服务器上已保存的配置；请先保存更改。AI 测试可能产生费用，不发送邮件。",
                "Fetch/test use saved server configuration; save changes first. AI tests may incur costs, but send no email.",
              )
            }}
          </p>
          <pre v-if="testResult">{{ testResult }}</pre>
          <div v-if="models.length" class="row mt-4">
            <Button
              v-for="m in models"
              :key="m.id"
              type="button"
              variant="outline"
              @click="editing.model = m.id"
              >{{ m.name || m.id }}</Button
            >
          </div>
        </form></DialogContent
      ></Dialog
    ><Dialog :open="!!deleting" @update:open="!$event && (deleting = undefined)"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{ t("确认删除", "Confirm deletion") }}</DialogTitle
          ><DialogDescription
            >{{ deleting?.name }} ·
            {{
              t("此操作不可撤销。", "This cannot be undone.")
            }}</DialogDescription
          ></DialogHeader
        >
        <p v-if="error" class="notice error">{{ error }}</p>
        <div class="actions">
          <Button variant="outline" @click="deleting = undefined">{{
            t("返回", "Back")
          }}</Button
          ><Button variant="destructive" :disabled="busy" @click="remove">{{
            t("确认删除", "Confirm delete")
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </section>
</template>
