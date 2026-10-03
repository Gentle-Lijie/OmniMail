<script setup lang="ts">
import { useMessages } from "@/lib/i18n";
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
import {
  attachmentIssue,
  draftFields,
  type AgentAttachment,
} from "@/lib/agent";
import { notify } from "@/lib/notifications";

const copy = useMessages("agentDialog");
const props = defineProps<{
  open: boolean;
  blank: boolean;
  kind: Kind;
  busy: boolean;
  title: string;
  message: string;
  conversation: Message[];
  attachments: AgentAttachment[];
  proposal?: {
    payload: Payload;
    message: string;
    mapping?: Record<string, string>;
  };
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
const proposalFields = computed(() =>
  draftFields[props.kind]
    .filter(
      (field) =>
        field !== "html" && Object.hasOwn(props.proposal?.payload ?? {}, field),
    )
    .map((field) => ({
      field,
      label:
        copy.value.fieldLabels[field as keyof typeof copy.value.fieldLabels],
      value: props.proposal!.payload[field],
    })),
);
let uploadController: AbortController | undefined;
const toolLabel = (name: string) =>
  (copy.value.tools as Record<string, string>)[name] || name;
const stageLabel = (stage: string) =>
  copy.value.stages[stage as keyof typeof copy.value.stages] || stage;
watch(
  () => [
    props.conversation.length,
    props.conversation.at(-1)?.thinking?.length,
    props.conversation.at(-1)?.stages?.length,
    props.conversation
      .at(-1)
      ?.toolCalls?.map((call) => call.status)
      .join(),
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
    count: copy.value.uploadAtMost5Attachments,
    size: copy.value.eachAttachmentMustBeNonEmptyAndAtMost5MB,
    type: copy.value.useTextPDFDOCXExcelOrPNGJPEGWebPImages,
    context: copy.value.attachmentLimits,
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
        throw Error(copy.value.attachmentTextCannotExceed200000Characters);
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
          ><Sparkles :size="18" />{{ copy.omniMailAgent }}</DialogTitle
        >
        <DialogDescription class="truncate"
          >{{ title }} · {{ copy.draftingOnlyNeverSends }}</DialogDescription
        >
      </DialogHeader>
      <div
        ref="transcript"
        class="agent-transcript min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
        aria-live="polite"
        aria-relevant="additions"
        :aria-label="copy.agentConversation"
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
            {{ blank ? copy.startWithAnIdea : copy.letSRefineThisDraft }}
          </h2>
          <p class="text-sm leading-6 text-muted-foreground">
            {{ copy.conversationHint }}
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
              entry.role === "user" ? copy.you : copy.omniMailAgent
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
                  ? copy.thinkingWorking
                  : entry.status === "cancelled"
                    ? copy.stopped
                    : entry.status === "error"
                      ? copy.processingIncomplete
                      : copy.processingSteps
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
                {{ copy.modelProvidedThinking }}
              </p>
              <p class="whitespace-pre-wrap break-words leading-5">
                {{ entry.thinking }}
              </p>
            </div>
            <p
              v-else-if="entry.status !== 'pending'"
              class="mt-3 text-muted-foreground"
            >
              {{ copy.missingThinkingHint }}
            </p>
          </details>
          <ol
            v-if="entry.toolCalls?.length"
            class="my-2 space-y-2 rounded-xl border p-3 text-xs"
            :aria-label="copy.toolOperations"
          >
            <li
              v-for="call in entry.toolCalls"
              :key="call.callId"
              class="flex items-start gap-2"
            >
              <LoaderCircle
                v-if="call.status === 'running'"
                :size="13"
                class="mt-1 shrink-0 animate-spin"
              />
              <Check
                v-else-if="call.status === 'complete'"
                :size="13"
                class="mt-1 shrink-0"
              />
              <X v-else :size="13" class="mt-1 shrink-0 text-destructive" />
              <span class="min-w-0 break-words"
                ><strong>{{ toolLabel(call.name) }}</strong
                ><span v-if="call.summary" class="ml-2 text-muted-foreground">{{
                  call.summary
                }}</span></span
              >
            </li>
          </ol>
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
              {{ copy.draftSuggestionNotApplied }}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :aria-expanded="expanded"
              @click="expanded = !expanded"
              >{{ expanded ? copy.hidePreview : copy.showPreview }}</Button
            >
          </div>
          <p
            v-for="field in proposalFields"
            :key="field.field"
            class="break-words text-sm"
          >
            <span class="text-muted-foreground">{{ field.label }}:</span>
            {{ field.value || copy.emptyField }}
          </p>
          <p
            v-for="(column, field) in proposal.mapping"
            :key="field"
            class="break-words text-sm"
          >
            <span class="text-muted-foreground">{{ copy.fieldMapping }}:</span>
            {{ field }} → {{ column }}
          </p>
          <iframe
            v-if="expanded"
            class="agent-draft-frame w-full rounded-md border bg-white"
            sandbox=""
            referrerpolicy="no-referrer"
            :title="copy.agentDraftPreview"
            :srcdoc="previewDocument(proposal.payload.html)"
          />
          <Button
            type="button"
            :disabled="busy || uploading"
            @click="emit('apply')"
            >{{ copy.applyDraft }}</Button
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
                :aria-label="copy.removeAttachment + attachment.name"
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
            :aria-label="copy.agentInstruction"
            :placeholder="copy.describeYourIdeaOrAskForFurtherChanges"
            @keydown="keydown"
          />
          <input
            ref="files"
            type="file"
            class="hidden"
            multiple
            accept=".txt,.md,.csv,.tsv,.json,.html,.htm,.xml,.log,.pdf,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp"
            :disabled="busy || uploading"
            :aria-label="copy.agentReferenceAttachments"
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
                :title="copy.attachmentHelp"
                @click="files?.click()"
                ><LoaderCircle
                  v-if="uploading"
                  :size="15"
                  class="animate-spin"
                /><Paperclip v-else :size="15" />{{
                  uploading ? copy.readingFiles : copy.attachFiles
                }}</Button
              ><span
                class="agent-composer-shortcut text-xs text-muted-foreground"
                >{{ copy.enterToSendShiftEnterForNewline }}</span
              >
            </div>
            <Button
              v-if="busy"
              type="button"
              variant="outline"
              size="sm"
              class="agent-composer-send"
              :aria-label="copy.stopGeneration"
              @click="emit('cancel')"
              ><Square :size="14" /><span class="agent-composer-send-label">{{
                copy.stopGeneration
              }}</span></Button
            ><Button
              v-else
              type="submit"
              size="sm"
              class="agent-composer-send"
              :disabled="uploading || !input.trim()"
              :aria-label="
                conversation.length
                  ? copy.sendFollowUp
                  : copy.generateDraftSuggestion
              "
              ><ArrowUp :size="15" /><span class="agent-composer-send-label">{{
                conversation.length
                  ? copy.sendFollowUp
                  : copy.generateDraftSuggestion
              }}</span></Button
            >
          </div>
        </form>
        <div
          class="flex items-start justify-between gap-3 text-[11px] text-muted-foreground"
        >
          <p class="flex min-w-0 items-start gap-1.5 leading-4">
            <ShieldCheck :size="12" class="mt-0.5" /><span>{{
              copy.aiPrivacyHint
            }}</span>
          </p>
          <Button
            type="button"
            variant="link"
            size="xs"
            :disabled="busy"
            @click="emit('settings')"
            >{{ copy.aISettings }}</Button
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
