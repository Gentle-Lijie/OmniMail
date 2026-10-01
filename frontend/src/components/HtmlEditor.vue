<script setup lang="ts">
import {
  ref,
  computed,
  nextTick,
  defineAsyncComponent,
  onErrorCaptured,
} from "vue";
import { Code, Eye, PenLine, Plus } from "lucide-vue-next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { escapeHtml, previewDocument } from "@/lib/mailMerge";
import { useFeedback } from "@/lib/notifications";
const RichEditor = defineAsyncComponent(() => import("./RichEditor.vue"));
const tokenLabel = (field: string) => `{{${field}}}`;
const props = defineProps<{
  t: (zh: string, en: string) => string;
  fields?: string[];
  dark?: boolean;
  disabled?: boolean;
  previewHtml?: string;
  previewSubject?: string;
}>();
const emit = defineEmits<{ agent: [] }>();
const model = defineModel<string>({ required: true });
const tab = ref("rich");
const rich = ref<InstanceType<typeof RichEditor>>();
const source = ref<HTMLElement>();
const richFailed = ref(false);
const richReady = ref(false);
useFeedback({
  pending: () =>
    !richReady.value && !richFailed.value
      ? props.t("正在加载富文本编辑器…", "Loading rich text editor…")
      : "",
  warning: () =>
    richFailed.value
      ? props.t(
          "富文本编辑器加载失败，已切换到 Raw HTML。",
          "Rich text failed to load. Switched to Raw HTML.",
        )
      : "",
});
let start = 0,
  end = 0;
const highlighted = computed(
  () =>
    escapeHtml(model.value).replace(
      /\{\{\s*[^{}]+?\s*\}\}/g,
      (token) => `<mark>${token}</mark>`,
    ) + "\n",
);
function remember() {
  const editor = source.value?.querySelector("textarea");
  if (editor) {
    start = editor.selectionStart;
    end = editor.selectionEnd;
  }
}
function syncScroll() {
  const editor = source.value?.querySelector("textarea"),
    overlay = source.value?.querySelector("pre");
  if (editor && overlay) {
    overlay.scrollTop = editor.scrollTop;
    overlay.scrollLeft = editor.scrollLeft;
  }
}
async function insert(field: string) {
  if (tab.value === "preview") tab.value = richFailed.value ? "source" : "rich";
  await nextTick();
  if (tab.value === "rich") {
    rich.value?.insert(field);
    return;
  }
  const token = `{{${field}}}`;
  model.value = model.value.slice(0, start) + token + model.value.slice(end);
  start += token.length;
  end = start;
  await nextTick();
  const editor = source.value?.querySelector("textarea");
  editor?.focus();
  editor?.setSelectionRange(start, end);
}
onErrorCaptured(() => {
  richFailed.value = true;
  tab.value = "source";
  return false;
});
</script>
<template>
  <div class="html-editor">
    <Tabs v-model="tab" class="editor-modes"
      ><TabsList
        ><TabsTrigger value="rich" :disabled="richFailed"
          ><PenLine :size="14" />TinyMCE</TabsTrigger
        ><TabsTrigger value="source"><Code :size="14" />Raw HTML</TabsTrigger
        ><TabsTrigger value="preview"
          ><Eye :size="14" />{{ t("预览", "Preview") }}</TabsTrigger
        ></TabsList
      ><span class="muted text-xs">{{
        t("字段高亮 · 点击插入", "Highlighted fields · click to insert")
      }}</span></Tabs
    >
    <div v-if="fields?.length" class="field-insert">
      <span>{{ t("插入字段", "Insert field") }}</span
      ><Button
        v-for="field in fields"
        type="button"
        :key="field"
        variant="secondary"
        size="xs"
        :disabled="disabled"
        @mousedown.prevent
        @click="insert(field)"
        >{{ tokenLabel(field) }}<Plus :size="12"
      /></Button>
    </div>

    <div v-show="tab === 'rich'" class="rich-surface">
      <Suspense
        ><RichEditor
          ref="rich"
          v-model="model"
          :dark="dark"
          :fields="fields"
          :disabled="disabled"
          @agent="emit('agent')"
          @ready="richReady = true"
          @failed="
            richFailed = true;
            tab = 'source';
          " /><template #fallback
          ><div class="empty" aria-busy="true"></div></template
      ></Suspense>
    </div>
    <div v-show="tab === 'source'" ref="source" class="source-surface">
      <pre aria-hidden="true" v-html="highlighted"></pre>
      <Textarea
        v-model="model"
        :aria-label="t('HTML 正文', 'HTML body')"
        spellcheck="false"
        :disabled="disabled"
        @click="remember"
        @keyup="remember"
        @select="remember"
        @blur="remember"
        @scroll="syncScroll"
      />
    </div>
    <div v-if="tab === 'preview'" class="preview-surface">
      <p v-if="previewSubject" class="preview-subject">
        {{ t("主题", "Subject") }}: {{ previewSubject }}
      </p>
      <iframe
        sandbox=""
        referrerpolicy="no-referrer"
        :title="t('HTML 安全预览', 'Sandboxed HTML preview')"
        :srcdoc="previewDocument(previewHtml ?? model)"
      />
    </div>
  </div>
</template>
