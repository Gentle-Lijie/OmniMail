<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Send, ExternalLink } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import AppCheckbox from "./ui/AppCheckbox.vue";
import { useMessages, message, taskError } from "@/lib/i18n";
import { api, ApiError, idPath, type Task } from "@/lib/api";
import { useFeedback } from "@/lib/notifications";
import { previewDocument } from "@/lib/mailMerge";
import { openMailPreview } from "@/lib/preview";
import {
  renderTestEmail,
  testEmailIssue,
  type TestEmailContent,
} from "@/lib/testEmail";

const props = defineProps<{ content?: TestEmailContent; dark?: boolean }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: []; expired: [] }>();
const copy = useMessages("testEmail");
const appCopy = useMessages("app");
const recipient = ref("");
const confirmed = ref(false);
const busy = ref(false);
const error = ref("");
const success = ref("");
const task = ref<Task>();
const sent = ref(false);
const rendered = computed(() =>
  props.content ? renderTestEmail(props.content) : undefined,
);
const issue = computed(() =>
  props.content ? testEmailIssue(props.content, recipient.value) : "",
);
const sampleLabel = computed(() =>
  props.content?.sample === undefined
    ? copy.value.singleMessage
    : message("testEmail.sample", { row: props.content.sample + 1 }),
);
const dialogOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (!busy.value) open.value = value;
  },
});
const status = computed(() =>
  task.value ? appCopy.value.statuses[task.value.status] : "",
);
let poll: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
useFeedback({
  error,
  success,
  pending: () => (busy.value ? copy.value.sending : ""),
});

watch(open, (value) => {
  generation++;
  clearTimeout(poll);
  if (!value) return;
  confirmed.value = false;
  error.value = "";
  success.value = "";
  task.value = undefined;
  sent.value = false;
});
watch(recipient, () => {
  confirmed.value = false;
  if (!sent.value) task.value = undefined;
});
onUnmounted(() => {
  generation++;
  clearTimeout(poll);
});

function reportState() {
  if (!task.value) return;
  if (task.value.status === "accepted") success.value = copy.value.accepted;
  else if (["failed", "uncertain", "cancelled"].includes(task.value.status))
    error.value = taskError(task.value.items?.[0]) || status.value;
}
async function refresh(id: string, current: number) {
  try {
    const loaded = await api<Task>("/tasks/" + idPath(id));
    if (current !== generation || !open.value) return;
    task.value = loaded;
    if (["queued", "running"].includes(loaded.status))
      poll = setTimeout(() => void refresh(id, current), 1500);
    else {
      reportState();
      emit("saved");
    }
  } catch (cause) {
    if (current !== generation || !open.value) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
  }
}
async function send() {
  if (
    busy.value ||
    sent.value ||
    !confirmed.value ||
    issue.value ||
    !props.content
  )
    return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    if (!task.value) {
      const { sample: _sample, ...content } = props.content;
      task.value = await api<Task>("/tasks/test-email", "POST", {
        recipient: recipient.value,
        ...content,
      });
    }
    // Once confirmation is attempted, inspect the task instead of creating or
    // confirming another task after an ambiguous network response.
    sent.value = true;
    task.value = await api<Task>(
      "/tasks/" + idPath(task.value.id) + "/confirm",
      "POST",
      {},
    );
    success.value = copy.value.queued;
    emit("saved");
    void refresh(task.value.id, generation);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
    if (sent.value && task.value) {
      emit("saved");
      void refresh(task.value.id, generation);
    }
  } finally {
    busy.value = false;
  }
}
function preview() {
  if (!rendered.value) return;
  try {
    openMailPreview({
      ...rendered.value,
      sample: props.content?.sample,
      dark: props.dark,
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="test-email-dialog">
      <DialogHeader>
        <DialogTitle>{{ copy.title }}</DialogTitle>
        <DialogDescription>{{ copy.description }}</DialogDescription>
      </DialogHeader>
      <label class="field">
        <span>{{ copy.recipient }}</span>
        <Input
          v-model="recipient"
          type="email"
          autocomplete="email"
          :placeholder="copy.placeholder"
          :disabled="busy || sent"
        />
      </label>
      <p
        v-if="recipient.trim() && issue && !sent"
        class="test-email-validation"
        role="status"
      >
        {{ issue }}
      </p>
      <div v-if="rendered" class="test-email-content">
        <div class="row between">
          <strong>{{ rendered.subject || copy.emptySubject }}</strong>
          <Button variant="ghost" size="sm" @click="preview"
            ><ExternalLink :size="14" />{{ copy.preview }}</Button
          >
        </div>
        <p class="muted text-xs">{{ sampleLabel }}</p>
        <iframe
          sandbox=""
          referrerpolicy="no-referrer"
          :title="copy.body"
          :srcdoc="previewDocument(rendered.html)"
        />
      </div>
      <label v-if="!sent" class="confirm-check">
        <AppCheckbox v-model="confirmed" :disabled="busy || !!issue" />
        <span>{{ copy.confirm }}</span>
      </label>
      <div v-if="task" class="test-email-result" role="status">
        <strong>{{ status }}</strong>
        <p class="muted text-xs">{{ copy.deliveryHint }}</p>
      </div>
      <div class="actions">
        <Button
          variant="outline"
          :disabled="busy"
          @click="dialogOpen = false"
          >{{ copy.close }}</Button
        >
        <Button
          :disabled="busy || sent || !confirmed || !!issue || !content"
          @click="send"
          ><Send :size="15" />{{ copy.send }}</Button
        >
      </div>
    </DialogContent>
  </Dialog>
</template>
