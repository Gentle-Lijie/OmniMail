<script setup lang="ts">
import { computed, ref } from "vue";
import AppSelect from "./ui/AppSelect.vue";
import { previewDocument } from "@/lib/mailMerge";
import type { Task } from "@/lib/api";
import { useFeedback } from "@/lib/notifications";
const props = defineProps<{
  task: Task;
  t: (zh: string, en: string) => string;
}>();
const selected = ref("0");
const item = computed(() => props.task.items?.[Number(selected.value)]);
useFeedback({ error: () => item.value?.error || "" });
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
      :aria-label="t('查看执行条目', 'View task item')"
    />
    <dl v-if="content" class="content-facts">
      <div>
        <dt>{{ t("主题", "Subject") }}</dt>
        <dd>{{ content.subject }}</dd>
      </div>
      <div>
        <dt>{{ t("收件人 / 参会者", "Recipients / attendees") }}</dt>
        <dd>
          {{ content.to || content.requiredAttendees || t("无", "None") }}
        </dd>
      </div>
      <div v-if="content.cc || content.optionalAttendees">
        <dt>{{ t("抄送 / 可选参会者", "CC / optional attendees") }}</dt>
        <dd>{{ content.cc || content.optionalAttendees }}</dd>
      </div>
      <div v-if="content.bcc">
        <dt>BCC</dt>
        <dd>{{ content.bcc }}</dd>
      </div>
      <div v-if="content.start">
        <dt>{{ t("时间 · 北京时间", "Time · Beijing time") }}</dt>
        <dd>{{ content.start }} — {{ content.end }}</dd>
      </div>
      <div v-if="content.location">
        <dt>{{ t("地点", "Location") }}</dt>
        <dd>{{ content.location }}</dd>
      </div>
    </dl>

    <iframe
      v-if="content?.html"
      class="email-preview"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="t('邮件正文预览', 'Message body preview')"
      :srcdoc="previewDocument(content.html)"
    />
    <p v-else class="muted text-sm">
      {{ t("此条目没有正文。", "This item has no body.") }}
    </p>
  </div>
</template>
