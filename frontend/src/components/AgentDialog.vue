<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import {
  Sparkles,
  ArrowUp,
  LoaderCircle,
  ShieldCheck,
  Paperclip,
  FileText,
  Image,
  X,
  Square,
  Check,
  ChevronDown,
} from "lucide-vue-next";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { previewDocument } from "@/lib/mailMerge";
import { api, type Kind, type Payload, type Message } from "@/lib/api";
import { attachmentIssue, type AgentAttachment } from "@/lib/agent";
import { notify } from "@/lib/notifications";
const props = defineProps<{
  open: boolean;
  blank: boolean;
  kind: Kind;
  busy: boolean;
  title: string;
  message: string;
  conversation: Message[];
  attachments: AgentAttachment[];
  proposal?: { payload: Payload; message: string };
  t: (zh: string, en: string) => string;
}>();
const emit = defineEmits<{
  "update:open": [boolean];
  "update:message": [string];
  "update:attachments": [AgentAttachment[]];
  request: [string];
  apply: [];
  cancel: [];
  settings: [];
  invalidate: [];
}>();
const input = computed({
  get: () => props.message,
  set: (value) => emit("update:message", value),
});
const files = ref<HTMLInputElement>();
const transcript = ref<HTMLElement>();
const uploading = ref(false);
const expanded = ref(true);
let uploadController: AbortController | undefined;
const stageLabel = (stage: string) => {
  const labels: Record<string, [string, string]> = {
    context: [
      "整理草稿、对话和附件上下文",
      "Preparing draft, conversation and attachments",
    ],
    model: [
      "正在调用模型，等待生成",
      "Calling the model; waiting for generation",
    ],
    drafting: ["正在生成起草建议", "Generating the draft suggestion"],
    validating: [
      "检查草稿结构与字段映射",
      "Validating draft structure and field mapping",
    ],
  };
  const label = labels[stage];
  return label ? props.t(...label) : stage;
};
watch(
  () => [
    props.conversation.length,
    props.conversation.at(-1)?.thinking?.length,
    props.conversation.at(-1)?.stages?.length,
    props.busy,
  ],
  async () => {
    await nextTick();
    if (transcript.value)
      transcript.value.scrollTop = transcript.value.scrollHeight;
  },
);
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    if (transcript.value)
      transcript.value.scrollTop = transcript.value.scrollHeight;
  },
);
onScopeDispose(() => uploadController?.abort());
async function upload(selected: File[]) {
  if (!selected.length || uploading.value || props.busy) return;
  const issue = attachmentIssue(props.attachments, selected);
  const issues = {
    count: props.t("最多上传 5 个附件。", "Upload at most 5 attachments."),
    size: props.t(
      "附件必须非空，且每个不超过 5 MB。",
      "Each attachment must be non-empty and at most 5 MB.",
    ),
    type: props.t(
      "支持文本、PDF、DOCX、Excel 和 PNG/JPEG/WebP 图片。",
      "Use text, PDF, DOCX, Excel or PNG/JPEG/WebP images.",
    ),
    context: props.t(
      "附件总计最多 10 MB，其中图片总计最多 3 MB。",
      "Attachments: 10 MB total, including at most 3 MB of images.",
    ),
  };
  if (issue) {
    notify.warning(issues[issue]);
    return;
  }
  uploading.value = true;
  uploadController = new AbortController();
  const signal = uploadController.signal;
  let current = [...props.attachments];
  try {
    for (const file of selected) {
      const body = new FormData();
      body.append("file", file);
      const attachment = await api<AgentAttachment>(
        "/agent/attachments",
        "POST",
        body,
        { signal },
      );
      if (signal.aborted) return;
      if (
        current.reduce(
          (length, entry) => length + (entry.text?.length || 0),
          0,
        ) +
          (attachment.text?.length || 0) >
        200000
      )
        throw Error(
          props.t(
            "附件文本总计不能超过 200,000 字符。",
            "Attachment text cannot exceed 200,000 characters.",
          ),
        );
      current = [...current, attachment];
      emit("update:attachments", current);
      emit("invalidate");
    }
  } catch (error) {
    if (!signal.aborted)
      notify.error(error instanceof Error ? error.message : String(error));
  } finally {
    uploading.value = false;
  }
}
function pick(event: Event) {
  const target = event.target as HTMLInputElement;
  void upload(Array.from(target.files || []));
  target.value = "";
}
function drop(event: DragEvent) {
  event.preventDefault();
  void upload(Array.from(event.dataTransfer?.files || []));
}
function remove(index: number) {
  emit(
    "update:attachments",
    props.attachments.filter((_, position) => position !== index),
  );
  emit("invalidate");
}
function submit() {
  if (props.busy || uploading.value || !input.value.trim()) return;
  emit("request", input.value.trim());
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}
function openChanged(open: boolean) {
  if (!open && props.busy) return;
  emit("update:open", open);
}
</script>
<template>
  <Dialog :open="open" @update:open="openChanged">
    <DialogContent
      class="agent-thread-dialog flex h-[min(760px,calc(100dvh-32px))] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      @escape-key-down="busy && $event.preventDefault()"
      @interact-outside="busy && $event.preventDefault()"
      @dragover.prevent
      @drop="drop"
    >
      <DialogHeader class="shrink-0 gap-y-1 border-b px-5 py-3 pr-12 text-left">
        <DialogTitle class="flex items-center gap-2 text-base"
          ><Sparkles :size="18" />OmniMail Agent</DialogTitle
        >
        <DialogDescription class="truncate"
          >{{ title }} ·
          {{
            t("只起草，不发送", "Drafting only; never sends")
          }}</DialogDescription
        >
      </DialogHeader>
      <div
        ref="transcript"
        class="agent-transcript min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
        aria-live="polite"
        aria-relevant="additions"
        :aria-label="t('Agent 对话', 'Agent conversation')"
      >
        <div
          v-if="!conversation.length"
          class="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-3 text-center"
        >
          <div
            class="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
          >
            <Sparkles :size="20" />
          </div>
          <h2 class="text-lg font-semibold">
            {{
              blank
                ? t("从一个想法开始", "Start with an idea")
                : t("一起完善这份草稿", "Let's refine this draft")
            }}
          </h2>
          <p class="text-sm leading-6 text-muted-foreground">
            {{
              t(
                "告诉我目的、背景和语气，也可以上传参考资料。无需模板，我会准备主题与正文供你审核。",
                "Describe your goal, context and tone, or attach reference files. No template needed; review the subject and body before applying.",
              )
            }}
          </p>
        </div>
        <article
          v-for="(entry, index) in conversation"
          :key="index"
          class="min-w-0"
          :class="
            entry.role === 'user'
              ? 'ml-auto max-w-[90%] rounded-xl bg-muted px-4 py-2.5'
              : 'space-y-2'
          "
        >
          <div
            class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground"
          >
            <Sparkles v-if="entry.role !== 'user'" :size="14" />{{
              entry.role === "user" ? t("你", "You") : "OmniMail Agent"
            }}
          </div>
          <div
            v-if="entry.attachments?.length"
            class="mb-2 flex flex-wrap gap-2"
          >
            <span
              v-for="(attachment, attachmentIndex) in entry.attachments"
              :key="attachmentIndex"
              class="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs"
              ><FileText :size="12" /><span class="truncate">{{
                attachment.name
              }}</span></span
            >
          </div>
          <details
            v-if="
              entry.role !== 'user' &&
              (entry.stages?.length ||
                entry.thinking ||
                entry.status === 'pending')
            "
            :open="entry.status === 'pending'"
            class="agent-thinking rounded-xl border bg-muted/40 p-3 text-xs"
          >
            <summary
              class="flex cursor-pointer list-none items-center gap-2 font-medium"
            >
              <LoaderCircle
                v-if="entry.status === 'pending'"
                :size="14"
                class="animate-spin"
              /><Check
                v-else-if="entry.status === 'complete'"
                :size="14"
              /><Square v-else :size="14" />{{
                entry.status === "pending"
                  ? t("Thinking · 正在处理", "Thinking · Working")
                  : entry.status === "cancelled"
                    ? t("已停止", "Stopped")
                    : entry.status === "error"
                      ? t("处理未完成", "Processing incomplete")
                      : t("处理过程", "Processing steps")
              }}<ChevronDown :size="13" class="ml-auto" />
            </summary>
            <ol class="mt-3 space-y-2 text-muted-foreground">
              <li
                v-for="stage in entry.stages"
                :key="stage"
                class="flex items-start gap-2"
              >
                <span class="mt-1 size-1 shrink-0 rounded-full bg-current" />{{
                  stageLabel(stage)
                }}
              </li>
            </ol>
            <div v-if="entry.thinking" class="mt-3 border-t pt-3">
              <p class="mb-2 font-medium">
                {{ t("模型返回的思考摘要", "Model-provided thinking") }}
              </p>
              <p class="whitespace-pre-wrap break-words leading-5">
                {{ entry.thinking }}
              </p>
            </div>
            <p
              v-else-if="entry.status !== 'pending'"
              class="mt-3 text-muted-foreground"
            >
              {{
                t(
                  "该服务商未返回思考摘要；以上为真实处理阶段。",
                  "This provider returned no thinking summary; the stages above reflect actual processing.",
                )
              }}
            </p>
          </details>
          <p
            v-if="entry.content"
            class="whitespace-pre-wrap break-words text-sm leading-5"
            :class="entry.status === 'error' ? 'text-destructive' : ''"
          >
            {{ entry.content }}
          </p>
        </article>
        <section
          v-if="proposal"
          class="agent-draft-preview space-y-2 rounded-xl border p-3"
        >
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold">
              {{ t("草稿建议 · 尚未应用", "Draft suggestion · Not applied") }}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :aria-expanded="expanded"
              @click="expanded = !expanded"
              >{{
                expanded
                  ? t("收起预览", "Hide preview")
                  : t("展开预览", "Show preview")
              }}</Button
            >
          </div>
          <p class="break-words text-sm">
            <span class="text-muted-foreground"
              >{{ t("主题", "Subject") }}:</span
            >
            {{ proposal.payload.subject }}
          </p>
          <iframe
            v-if="expanded"
            class="agent-draft-frame w-full rounded-md border bg-white"
            sandbox=""
            referrerpolicy="no-referrer"
            :title="t('Agent 起草预览', 'Agent draft preview')"
            :srcdoc="previewDocument(proposal.payload.html)"
          />
          <Button
            type="button"
            :disabled="busy || uploading"
            @click="emit('apply')"
            >{{ t("应用主题与正文", "Apply subject & body") }}</Button
          >
        </section>
      </div>
      <div
        class="agent-composer-panel shrink-0 space-y-2 border-t bg-background"
      >
        <form class="agent-composer" @submit.prevent="submit">
          <div
            v-if="attachments.length"
            class="mb-2 flex max-h-24 flex-wrap gap-2 overflow-y-auto"
          >
            <div
              v-for="(attachment, index) in attachments"
              :key="index"
              class="flex max-w-full items-center gap-2 rounded-lg border bg-muted/40 py-1 pl-2"
            >
              <Image v-if="attachment.kind === 'image'" :size="14" /><FileText
                v-else
                :size="14"
              /><span
                class="min-w-0 max-w-[160px] truncate text-xs"
                :title="attachment.name"
                >{{ attachment.name }}</span
              ><Button
                type="button"
                variant="ghost"
                size="icon-sm"
                :disabled="busy || uploading"
                :aria-label="
                  t('移除附件 ', 'Remove attachment ') + attachment.name
                "
                @click="remove(index)"
                ><X :size="13"
              /></Button>
            </div>
          </div>
          <Textarea
            v-model="input"
            class="agent-composer-input"
            :disabled="busy"
            maxlength="10000"
            rows="3"
            :aria-label="t('Agent 指令', 'Agent instruction')"
            :placeholder="
              t(
                '描述你的想法，或继续提出修改要求…',
                'Describe your idea, or ask for further changes…',
              )
            "
            @keydown="keydown"
          />
          <input
            ref="files"
            type="file"
            class="hidden"
            multiple
            accept=".txt,.md,.csv,.tsv,.json,.html,.htm,.xml,.log,.pdf,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp"
            :disabled="busy || uploading"
            :aria-label="t('Agent 参考附件', 'Agent reference attachments')"
            @change="pick"
          />
          <div class="agent-composer-toolbar">
            <div class="flex min-w-0 items-center gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="agent-composer-attach"
                :disabled="busy || uploading"
                :title="
                  t(
                    '支持文本、PDF、DOCX、Excel 和图片；最多 5 个文件，每个 5 MB，总计 10 MB，图片合计 3 MB。',
                    'Text, PDF, DOCX, Excel and images; up to 5 files, 5 MB each, 10 MB total, including 3 MB of images.',
                  )
                "
                @click="files?.click()"
                ><LoaderCircle
                  v-if="uploading"
                  :size="15"
                  class="animate-spin"
                /><Paperclip v-else :size="15" />{{
                  uploading
                    ? t("读取附件…", "Reading files…")
                    : t("上传文件", "Attach files")
                }}</Button
              ><span
                class="agent-composer-shortcut text-xs text-muted-foreground"
                >{{
                  t(
                    "Enter 发送 · Shift+Enter 换行",
                    "Enter to send · Shift+Enter for newline",
                  )
                }}</span
              >
            </div>
            <Button
              v-if="busy"
              type="button"
              variant="outline"
              size="sm"
              class="agent-composer-send"
              :aria-label="t('停止生成', 'Stop generation')"
              @click="emit('cancel')"
              ><Square :size="14" /><span class="agent-composer-send-label">{{
                t("停止生成", "Stop generation")
              }}</span></Button
            ><Button
              v-else
              type="submit"
              size="sm"
              class="agent-composer-send"
              :disabled="uploading || !input.trim()"
              :aria-label="
                t(
                  conversation.length ? '发送修改要求' : '生成起草建议',
                  conversation.length
                    ? 'Send follow-up'
                    : 'Generate draft suggestion',
                )
              "
              ><ArrowUp :size="15" /><span class="agent-composer-send-label">{{
                t(
                  conversation.length ? "发送修改要求" : "生成起草建议",
                  conversation.length
                    ? "Send follow-up"
                    : "Generate draft suggestion",
                )
              }}</span></Button
            >
          </div>
        </form>
        <div
          class="flex items-start justify-between gap-3 text-[11px] text-muted-foreground"
        >
          <p class="flex min-w-0 items-start gap-1.5 leading-4">
            <ShieldCheck :size="12" class="mt-0.5" /><span>{{
              t(
                "对话、正文和附件会交给已配置的 AI。应用仅更新主题与正文，不发送邮件。",
                "Conversation, draft and attachments go to your configured AI. Applying only updates subject and body; no mail is sent.",
              )
            }}</span>
          </p>
          <Button
            type="button"
            variant="link"
            size="xs"
            :disabled="busy"
            @click="emit('settings')"
            >{{ t("AI 配置", "AI settings") }}</Button
          >
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
<style scoped>
:global([role="dialog"].agent-thread-dialog) {
  padding: 0;
  overflow: hidden;
}
.agent-draft-frame {
  height: 176px;
}
.agent-composer-panel {
  padding: 12px 20px;
}
.agent-composer {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--card);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.03);
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}
.agent-composer:focus-within {
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 8%, transparent);
}
.agent-composer-input {
  display: block;
  min-height: 72px;
  width: 100%;
  resize: none;
  border: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
  font-size: 14px;
  line-height: 1.7;
  box-shadow: none;
}
.agent-composer-input:focus-visible {
  outline: none;
  box-shadow: none;
}
.agent-composer-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.agent-composer-attach,
.agent-composer-send {
  height: 36px;
  border-radius: 9px;
  font-size: 13px;
}
.agent-composer-attach {
  color: var(--muted-foreground);
}
.agent-composer-shortcut {
  white-space: nowrap;
}
@media (max-width: 900px) {
  .agent-composer-shortcut {
    display: none;
  }
}
@media (max-width: 480px) {
  .agent-composer-panel {
    padding: 12px;
  }
  .agent-composer {
    padding: 12px;
  }
  .agent-composer-send {
    width: 36px;
    padding: 0;
  }
  .agent-composer-send-label {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-composer {
    transition: none;
  }
}
</style>
