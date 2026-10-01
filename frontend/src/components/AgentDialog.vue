<script setup lang="ts">
import { ref, watch } from "vue";
import { Sparkles, ArrowUp, LoaderCircle, ShieldCheck } from "lucide-vue-next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import AppSelect from "./ui/AppSelect.vue";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { previewDocument } from "@/lib/mailMerge";
import type { Kind, Payload } from "@/lib/api";
const props = defineProps<{
  open: boolean;
  blank: boolean;
  kind: Kind;
  busy: boolean;
  title: string;
  error: string;
  proposal?: { payload: Payload; message: string };
  t: (zh: string, en: string) => string;
}>();
const emit = defineEmits<{
  "update:open": [boolean];
  request: [string];
  apply: [];
  settings: [];
  invalidate: [];
}>();
const purpose = ref(""),
  audience = ref(""),
  details = ref(""),
  tone = ref("professional");
watch(
  () => props.title,
  () => {
    purpose.value = "";
    audience.value = "";
    details.value = "";
  },
);
watch([purpose, audience, details, tone], () => {
  if (!props.busy && props.proposal) emit("invalidate");
});
function request() {
  const toneLabel =
    tone.value === "friendly"
      ? props.t("友好自然", "Friendly")
      : tone.value === "concise"
        ? props.t("简洁直接", "Concise")
        : props.t("专业礼貌", "Professional");
  const instruction = [
    purpose.value.trim(),
    audience.value.trim()
      ? `${props.t("写给", "Audience")}: ${audience.value.trim()}`
      : "",
    `${props.t("语气", "Tone")}: ${toneLabel}`,
    details.value.trim()
      ? `${props.t("背景与要点", "Context and details")}: ${details.value.trim()}`
      : "",
    props.t(
      "请准备主题与 HTML 正文，保持收件人不变，不要虚构日期或事实。",
      "Prepare subject and HTML only. Keep recipients unchanged and do not invent dates or facts.",
    ),
  ]
    .filter(Boolean)
    .join("\n");
  emit("request", instruction);
}
</script>
<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)"
    ><DialogContent class="agent-dialog sm:max-w-2xl"
      ><DialogHeader
        ><DialogTitle class="icon-label"
          ><Sparkles :size="20" />OmniMail Agent</DialogTitle
        ><DialogDescription
          >{{ title }} ·
          {{
            t(
              "仅准备草稿，由你决定应用与执行。",
              "Drafts only. You decide what to apply and execute.",
            )
          }}</DialogDescription
        ></DialogHeader
      >
      <div v-if="blank && !proposal" class="agent-introduction">
        <div class="agent-emblem"><Sparkles :size="24" /></div>
        <h2>
          {{
            t(
              kind === "email"
                ? "第一封邮件，从一个想法开始。"
                : "新的日程，从一个想法开始。",
              kind === "email"
                ? "Your first draft starts with an idea."
                : "Your event starts with an idea.",
            )
          }}
        </h2>
        <p>
          {{
            t(
              "无需模板或收件地址。描述目的，我来准备主题与正文。",
              "No template or email address required. Describe your goal to prepare a subject and body.",
            )
          }}
        </p>
      </div>
      <form @submit.prevent="request">
        <label class="field"
          ><span>{{
            t(
              blank
                ? kind === "email"
                  ? "你想写一封什么邮件？"
                  : "你想安排什么日程？"
                : "希望怎样调整草稿？",
              blank
                ? kind === "email"
                  ? "What would you like to write?"
                  : "What event would you like to plan?"
                : "How should this draft change?",
            )
          }}</span
          ><Textarea
            v-model="purpose"
            :disabled="busy"
            rows="3"
            required
            :placeholder="
              t(
                '例如：跟进试点项目，请客户本周确认下一步安排',
                'For example: follow up on a pilot and ask the client to confirm next steps this week',
              )
            "
        /></label>
        <div class="form-grid">
          <label class="field"
            ><span>{{
              t(
                "写给谁（选填，不设置邮箱）",
                "Audience (optional; no email address)",
              )
            }}</span
            ><Input v-model="audience" :disabled="busy" /></label
          ><label class="field"
            ><span>{{ t("表达语气", "Tone") }}</span
            ><AppSelect
              v-model="tone"
              :disabled="busy"
              :options="[
                { value: 'professional', label: t('专业礼貌', 'Professional') },
                { value: 'friendly', label: t('友好自然', 'Friendly') },
                { value: 'concise', label: t('简洁直接', 'Concise') },
              ]"
          /></label>
        </div>
        <label class="field"
          ><span>{{
            t("背景与关键内容（选填）", "Context and key details (optional)")
          }}</span
          ><Textarea v-model="details" :disabled="busy" rows="2"
        /></label>
        <div class="actions">
          <Button :disabled="busy || !purpose.trim()"
            ><LoaderCircle v-if="busy" class="animate-spin" /><ArrowUp
              v-else
            />{{
              t(
                proposal ? "重新生成建议" : "生成起草建议",
                proposal
                  ? "Regenerate suggestion"
                  : "Generate draft suggestion",
              )
            }}</Button
          >
        </div>
      </form>
      <p class="muted text-xs">
        {{
          t(
            "请求会将对话和当前正文交给已配置的 AI 服务；名单样本已脱敏。",
            "Requests share your conversation and current content with the configured AI. List samples are redacted.",
          )
        }}
      </p>
      <div v-if="error" class="notice error" role="alert">
        {{ error
        }}<Button variant="link" @click="emit('settings')">{{
          t("检查 AI 配置", "Check AI settings")
        }}</Button>
      </div>
      <section v-if="proposal" class="agent-proposal">
        <div class="row between">
          <h2>{{ t("建议预览", "Suggestion preview") }}</h2>
          <span class="badge">{{ t("未应用", "Not applied") }}</span>
        </div>
        <p class="muted text-sm">{{ proposal.message }}</p>
        <p class="preview-subject">
          {{ t("主题", "Subject") }}: {{ proposal.payload.subject }}
        </p>
        <iframe
          sandbox=""
          referrerpolicy="no-referrer"
          :title="t('Agent 起草预览', 'Agent draft preview')"
          :srcdoc="previewDocument(proposal.payload.html)"
        />
      </section>
      <div class="dialog-sticky-actions">
        <p class="muted icon-label text-xs">
          <ShieldCheck :size="15" />{{
            t(
              kind === "email"
                ? "应用只更新主题与正文，不修改收件人。"
                : "应用只更新主题与正文，不修改参会者或时间。",
              kind === "email"
                ? "Apply updates subject and body only, never recipients."
                : "Apply updates subject and body only, never attendees or times.",
            )
          }}
        </p>
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="emit('update:open', false)"
            >{{ t("先自己写", "Write myself") }}</Button
          ><Button :disabled="busy || !proposal" @click="emit('apply')">{{
            t("应用主题与正文", "Apply subject & body")
          }}</Button>
        </div>
      </div>
    </DialogContent></Dialog
  >
</template>
