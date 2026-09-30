<script setup lang="ts">
import { ref, defineAsyncComponent } from "vue";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
const RichEditor = defineAsyncComponent(() => import("./RichEditor.vue"));
defineProps<{ t: (zh: string, en: string) => string }>();
const model = defineModel<string>({ required: true });
const tab = ref("source");
const previewPrefix = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">`;
</script>
<template>
  <Tabs v-model="tab" class="mt-3"
    ><TabsList
      ><TabsTrigger value="source">{{ t("源码", "Source") }}</TabsTrigger
      ><TabsTrigger value="rich">{{ t("富文本", "Rich text") }}</TabsTrigger
      ><TabsTrigger value="preview">{{
        t("预览", "Preview")
      }}</TabsTrigger></TabsList
    ><TabsContent value="source"
      ><Textarea
        v-model="model"
        :aria-label="t('HTML 正文', 'HTML body')"
        rows="12"
        spellcheck="false" /></TabsContent
    ><TabsContent value="rich"
      ><Suspense
        ><RichEditor v-model="model" /><template #fallback
          ><p role="status">
            {{ t("正在加载编辑器…", "Loading editor…") }}
          </p></template
        ></Suspense
      ></TabsContent
    ><TabsContent value="preview"
      ><iframe
        sandbox=""
        referrerpolicy="no-referrer"
        :title="t('HTML 安全预览', 'Sandboxed HTML preview')"
        :srcdoc="previewPrefix + model" /></TabsContent
  ></Tabs>
</template>
