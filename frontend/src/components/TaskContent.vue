<script setup lang="ts">
import { useMessages, taskError } from "@/lib/i18n";
import { computed, ref } from "vue";
import AppSelect from "./ui/AppSelect.vue";
import { previewDocument } from "@/lib/mailMerge";
import type { Task } from "@/lib/api";
import { useFeedback } from "@/lib/notifications";

const copy = useMessages("taskContent");
const props = defineProps<{
  task: Task;
}>();
const selected = ref("0");
const item = computed(() => props.task.items?.[Number(selected.value)]);
useFeedback({ error: () => taskError(item.value) });
const content = computed(() => item.value?.payload || props.task.payload);
const options = computed(() =>
  (props.task.items || []).map((entry, index) => ({
    value: String(index),
    label: `${index + 1} · ${entry.payload.to || entry.payload.requiredAttendees || entry.payload.subject}`,
  })),
);
</script>
<template>
  <div class="task-content">
    <AppSelect
      v-if="options.length"
      v-model="selected"
      :options="options"
      :aria-label="copy.viewTaskItem"
    />
    <dl v-if="content" class="content-facts">
      <div>
        <dt>{{ copy.subject }}</dt>
        <dd>{{ content.subject }}</dd>
      </div>
      <div>
        <dt>{{ copy.recipientsAttendees }}</dt>
        <dd>
          {{ content.to || content.requiredAttendees || copy.none }}
        </dd>
      </div>
      <div v-if="content.cc || content.optionalAttendees">
        <dt>{{ copy.cCOptionalAttendees }}</dt>
        <dd>{{ content.cc || content.optionalAttendees }}</dd>
      </div>
      <div v-if="content.bcc">
        <dt>{{ copy.bcc }}</dt>
        <dd>{{ content.bcc }}</dd>
      </div>
      <div v-if="content.start">
        <dt>{{ copy.timeBeijingTime }}</dt>
        <dd>{{ content.start }} — {{ content.end }}</dd>
      </div>
      <div v-if="content.location">
        <dt>{{ copy.location }}</dt>
        <dd>{{ content.location }}</dd>
      </div>
    </dl>

    <iframe
      v-if="content?.html"
      class="email-preview"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="copy.messageBodyPreview"
      :srcdoc="previewDocument(content.html)"
    />
    <p v-else class="muted text-sm">
      {{ copy.thisItemHasNoBody }}
    </p>
  </div>
</template>
