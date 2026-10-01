<script setup lang="ts">
import { ref, onMounted } from "vue";
import { startRegistration } from "@simplewebauthn/browser";
import AppSelect from "@/components/ui/AppSelect.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
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
import AIProviderSettings from "@/components/AIProviderSettings.vue";
import { api, idPath, type Settings, type Key } from "@/lib/api";
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
              ><AppSelect
                v-model="language"
                :options="[
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: 'English' },
                ]" /></label
            ><label class="field"
              ><span>{{ t("速率间隔（毫秒）", "Rate interval (ms)") }}</span
              ><Input
                v-model="settings.rateLimitMs"
                type="number"
                min="0"
                required /></label
            ><label class="row mt-4"
              ><AppCheckbox v-model="settings.registrationEnabled" />{{
                t("允许注册新 Passkey", "Allow new passkey registration")
              }}</label
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
          ><AIProviderSettings
            :providers="settings?.providers || []"
            :default-provider-id="settings?.defaultProviderId || ''"
            :t="t"
            @updated="run(load)"
        /></Card>
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
    <Dialog :open="!!deleting" @update:open="!$event && (deleting = undefined)"
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
