<script setup lang="ts">
import { watch } from "vue";
import Editor from "@tinymce/tinymce-vue";
import type { Editor as TinyEditor, RawEditorOptions } from "tinymce";
import "tinymce/tinymce";
import "tinymce/icons/default";
import "tinymce/themes/silver";
import "tinymce/models/dom";
import "tinymce/plugins/link";
import "tinymce/plugins/lists";
import "tinymce/skins/ui/oxide/skin.min.css";
import contentCss from "tinymce/skins/content/default/content.min.css?inline";
import uiCss from "tinymce/skins/ui/oxide/content.min.css?inline";
import { escapeHtml } from "@/lib/mailMerge";
const props = defineProps<{
  dark?: boolean;
  disabled?: boolean;
  fields?: string[];
}>();
const emit = defineEmits<{ agent: []; failed: [] }>();
const model = defineModel<string>({ required: true });
let editor: TinyEditor | undefined;
let bookmark: ReturnType<TinyEditor["selection"]["getBookmark"]> | undefined;
function contentStyle() {
  return `${uiCss}\n${contentCss}\nbody{margin:24px;font:14px/1.85 system-ui;color:${props.dark ? "#e0e7f4" : "#253249"};background:${props.dark ? "#182131" : "#fff"};overflow-wrap:anywhere}h2{color:${props.dark ? "#7a9cff" : "#3468ed"}}.mceNonEditable{padding:2px 5px;border-radius:4px;background:${props.dark ? "#233655" : "#edf3ff"};color:${props.dark ? "#9eb8ff" : "#3468ed"};border:1px solid ${props.dark ? "#395378" : "#d9e4ff"};font:12px/1.7 ui-monospace,monospace}`;
}
function insert(field: string) {
  if (!editor) return;
  editor.focus();
  if (bookmark) editor.selection.moveToBookmark(bookmark);
  editor.undoManager.transact(() =>
    editor!.insertContent(escapeHtml(`{{${field}}}`)),
  );
  model.value = editor.getContent();
  bookmark = editor.selection.getBookmark(2, true);
}
const init: RawEditorOptions = {
  license_key: "gpl",
  height: 350,
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
    instance.ui.registry.addMenuButton("mergefields", {
      text: "{{ }}",
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
    instance.on("init", () => {
      instance.addShortcut("meta+k", "OmniMail Agent", () => emit("agent"));
      instance.addShortcut("ctrl+k", "OmniMail Agent", () => emit("agent"));
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
};
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
  <Editor
    v-model="model"
    license-key="gpl"
    :init="init"
    :disabled="disabled"
    @error="emit('failed')"
  />
</template>
