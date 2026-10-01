<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { Input } from "./ui/input";
import { insertFieldToken } from "@/lib/fieldInsertion";
import {
  fieldEditorHtml,
  fieldEditorSelection,
  fieldEditorText,
  setFieldEditorSelection,
} from "@/lib/fieldEditor";

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  type?: string;
  disabled?: boolean;
  readonly?: boolean;
  t: (zh: string, en: string) => string;
}>();
const model = defineModel<string>({ required: true });
const editor = ref<HTMLElement>();
const dateInput = ref<InstanceType<typeof Input>>();
const isDateInput = computed(
  () => props.type === "datetime-local" && !model.value?.includes("{"),
);
const html = computed(() =>
  fieldEditorHtml(
    model.value || "",
    props.t("移除", "Remove"),
    !!props.readonly || !!props.disabled,
  ),
);
let selection: { start: number; end: number } | undefined;
const composing = ref(false);

function remember() {
  if (editor.value) selection = fieldEditorSelection(editor.value) || selection;
}
async function focus() {
  await nextTick();
  if (isDateInput.value)
    (dateInput.value?.$el as HTMLInputElement | undefined)?.focus();
  else editor.value?.focus();
}
async function update(value: string, caret: { start: number; end: number }) {
  selection = caret;
  model.value = value;
  await nextTick();
  const root = editor.value;
  if (root) {
    root.focus();
    setFieldEditorSelection(root, caret.start, caret.end);
    selection = caret;
  }
}
async function insert(field: string) {
  if (props.disabled || props.readonly) return;
  if (!isDateInput.value) remember();
  const result = isDateInput.value
    ? insertFieldToken(model.value, field, 0, model.value.length)
    : insertFieldToken(model.value, field, selection?.start, selection?.end);
  await update(result.value, { start: result.caret, end: result.caret });
}
function onInput(event: Event) {
  if (
    props.disabled ||
    props.readonly ||
    composing.value ||
    (event as InputEvent).isComposing ||
    !editor.value
  )
    return;
  const root = editor.value;
  const caret = fieldEditorSelection(root) || { start: 0, end: 0 };
  void update(fieldEditorText(root), caret);
}
function paste(event: ClipboardEvent) {
  if (props.disabled || props.readonly || !event.clipboardData) return;
  event.preventDefault();
  remember();
  const text = event.clipboardData
    .getData("text/plain")
    .replace(/[\r\n]+/g, " ");
  const start = selection?.start ?? model.value.length;
  const end = selection?.end ?? start;
  void update(model.value.slice(0, start) + text + model.value.slice(end), {
    start: start + text.length,
    end: start + text.length,
  });
}
function click(event: MouseEvent) {
  const button = (event.target as Element).closest<HTMLButtonElement>(
    "button[data-remove-field]",
  );
  if (!button || props.disabled || props.readonly) {
    remember();
    return;
  }
  const start = Number(button.dataset.removeField);
  const token = model.value.slice(start).match(/^{{\s*[^{}]+?\s*}}/);
  if (!token) return;
  const end = start + token[0].length;
  const adjust = (offset: number) =>
    offset >= end ? offset - token[0].length : offset > start ? start : offset;
  const caret = selection || { start, end: start };
  void update(model.value.slice(0, start) + model.value.slice(end), {
    start: adjust(caret.start),
    end: adjust(caret.end),
  });
}
function mousedown(event: MouseEvent) {
  if ((event.target as Element).closest("button[data-remove-field]"))
    event.preventDefault();
}
watch(model, async () => {
  await nextTick();
  if (
    editor.value &&
    editor.value.ownerDocument.activeElement === editor.value &&
    selection
  )
    setFieldEditorSelection(editor.value, selection.start, selection.end);
});
onMounted(() => document.addEventListener("selectionchange", remember));
onBeforeUnmount(() =>
  document.removeEventListener("selectionchange", remember),
);
defineExpose({ insert, focus });
</script>

<template>
  <div class="field-input">
    <Input
      v-if="isDateInput"
      ref="dateInput"
      v-model="model"
      v-bind="$attrs"
      type="datetime-local"
      :disabled="disabled"
      :readonly="readonly"
    />
    <div
      v-else
      ref="editor"
      v-bind="$attrs"
      class="field-input-editor"
      role="textbox"
      :contenteditable="!disabled && !readonly"
      :aria-disabled="disabled || undefined"
      :aria-readonly="readonly || undefined"
      :data-placeholder="$attrs.placeholder"
      :tabindex="disabled ? -1 : 0"
      spellcheck="false"
      @input="onInput"
      @paste="paste"
      @focus="remember"
      @blur="remember"
      @keyup="remember"
      @mouseup="remember"
      @mousedown="mousedown"
      @click="click"
      @keydown.enter.prevent
      @compositionstart="composing = true"
      @compositionend="
        composing = false;
        onInput($event);
      "
      v-html="html"
    />
  </div>
</template>
