<script setup lang="ts">
import Editor from "@tinymce/tinymce-vue";
import "tinymce/tinymce";
import "tinymce/icons/default";
import "tinymce/themes/silver";
import "tinymce/models/dom";
import "tinymce/plugins/link";
import "tinymce/plugins/lists";
import "tinymce/skins/ui/oxide/skin.min.css";
import contentCss from "tinymce/skins/content/default/content.min.css?inline";
import uiCss from "tinymce/skins/ui/oxide/content.min.css?inline";
const model = defineModel<string>({ required: true });
const init = {
  license_key: "gpl",
  height: 320,
  menubar: false,
  skin: false,
  content_css: false,
  content_style: uiCss + "\n" + contentCss,
  plugins: "link lists",
  toolbar: "undo redo | bold italic | bullist numlist | link",
  promotion: false,
  branding: false,
};
</script>
<template><Editor v-model="model" :init="init" /></template>
