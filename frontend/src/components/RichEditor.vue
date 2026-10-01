<script setup lang="ts">
import { computed, watch } from "vue";
import { i18n, useMessages } from "@/lib/i18n";
import zhEditor from "@/locales/tinymce/zh_CN.json";
import Editor from "@tinymce/tinymce-vue";
import type { Editor as TinyEditor, RawEditorOptions } from "tinymce";
import tinymce from "tinymce/tinymce";
import "tinymce/icons/default";
import "tinymce/themes/silver";
import "tinymce/models/dom";
import "tinymce/plugins/link";
import "tinymce/plugins/lists";
import "tinymce/skins/ui/oxide/skin.min.css";
import contentCss from "tinymce/skins/content/default/content.min.css?inline";
import uiCss from "tinymce/skins/ui/oxide/content.min.css?inline";
import { escapeHtml } from "@/lib/mailMerge";

const copy = useMessages("richEditor");
const locale = computed(() => i18n.global.locale.value);

tinymce.addI18n("zh_CN", zhEditor);

const props = defineProps<{
  dark?: boolean;
  disabled?: boolean;
  fill?: boolean;
  fields?: string[];
}>();
const emit = defineEmits<{ agent: []; failed: []; ready: []; focus: [] }>();
const model = defineModel<string>({ required: true });
let editor: TinyEditor | undefined;
let bookmark: ReturnType<TinyEditor["selection"]["getBookmark"]> | undefined;
function contentStyle() {
  return `${uiCss}\n${contentCss}\nbody{margin:24px;font:14px/1.85 system-ui;color:${props.dark ? "#e0e7f4" : "#253249"};background:${props.dark ? "#182131" : "#fff"};overflow-wrap:anywhere}h2{color:${props.dark ? "#7a9cff" : "#3468ed"}}.mceNonEditable{padding:2px 5px;border-radius:4px;background:${props.dark ? "#233655" : "#edf3ff"};color:${props.dark ? "#9eb8ff" : "#3468ed"};border:1px solid ${props.dark ? "#395378" : "#d9e4ff"};font:12px/1.7 ui-monospace,monospace}`;
}
function insert(field: string) {
  if (!editor || props.disabled) return;
  const saved = editor.hasFocus() ? undefined : bookmark;
  editor.focus();
  if (saved) editor.selection.moveToBookmark(saved);
  editor.undoManager.transact(() => {
    const selectedToken = editor!.selection
      .getNode()
      .closest(".mceNonEditable");
    if (selectedToken) {
      editor!.selection.select(selectedToken);
      editor!.selection.collapse(false);
    }
    editor!.insertContent(escapeHtml(`{{${field}}}`));
    editor!.selection.collapse(false);
  });
  model.value = editor.getContent();
  bookmark = editor.selection.getBookmark(2, true);
}
const init = computed<RawEditorOptions>(() => ({
  language: locale.value === "zh" ? "zh_CN" : "en",
  license_key: "gpl",
  height: props.fill ? "100%" : 350,
  min_height: props.fill ? 0 : 100,
  resize: !props.fill,
  statusbar: !props.fill,
  menubar: false,
  skin: false,
  content_css: false,
  content_style: contentStyle(),
  plugins: "link lists",
  toolbar: "undo redo | bold italic | bullist numlist | link | mergefields",
  promotion: false,
  branding: false,
  noneditable_regexp: /\{\{\s*[^{}]+?\s*\}\}/g,
  content_security_policy:
    "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'",
  setup(instance) {
    editor = instance;
    bookmark = undefined;
    instance.ui.registry.addMenuButton("mergefields", {
      text: copy.value.mergeFields,
      fetch(callback) {
        callback(
          (props.fields || []).map((field) => ({
            type: "menuitem",
            text: `{{${field}}}`,
            onAction: () => insert(field),
          })),
        );
      },
    });
    instance.on(
      "blur",
      () => (bookmark = instance.selection.getBookmark(2, true)),
    );
    instance.on("SelectionChange keyup mouseup", () => {
      if (instance.hasFocus())
        bookmark = instance.selection.getBookmark(2, true);
    });
    instance.on("focus", () => emit("focus"));
    instance.on("init", () => {
      emit("ready");
      instance.addShortcut("meta+k", copy.value.omniMailAgent, () =>
        emit("agent"),
      );
      instance.addShortcut("ctrl+k", copy.value.omniMailAgent, () =>
        emit("agent"),
      );
    });
    instance.on("input", () => {
      const content = instance.getContent();
      const matches =
        instance.getBody().textContent?.match(/\{\{\s*[^{}]+?\s*\}\}/g) || [];
      if (
        matches.length >
        instance.getBody().querySelectorAll(".mceNonEditable").length
      ) {
        const saved = instance.selection.getBookmark(2, true);
        instance.undoManager.ignore(() => {
          instance.setContent(content);
          instance.selection.moveToBookmark(saved);
        });
      }
      model.value = instance.getContent();
    });
  },
}));
watch(
  () => props.dark,
  () => {
    if (!editor?.initialized) return;
    const document = editor.getDoc();
    let style = document.getElementById("editor-theme");
    if (!style) {
      style = document.createElement("style");
      style.id = "editor-theme";
      document.head.appendChild(style);
    }
    style.textContent = contentStyle();
  },
);
defineExpose({ insert });
</script>
<template>
  <div :key="locale" :class="{ 'h-full min-h-0': fill }">
    <Editor
      v-model="model"
      license-key="gpl"
      :init="init"
      :disabled="disabled"
      @error="emit('failed')"
    />
  </div>
</template>
