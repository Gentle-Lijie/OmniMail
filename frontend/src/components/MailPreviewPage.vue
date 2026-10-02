<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { Monitor, Smartphone, Mail, X } from "lucide-vue-next";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { useMessages, setLocale, savedLocale, message } from "@/lib/i18n";
import { previewDocument } from "@/lib/mailMerge";
import { receiveMailPreview, type PreviewSnapshot } from "@/lib/preview";

setLocale(savedLocale());
const copy = useMessages("mailPreview");
const snapshot = ref<PreviewSnapshot>();
const expired = ref(false);
const mode = ref(
  window.matchMedia("(max-width: 900px)").matches ? "mobile" : "desktop",
);
const width = computed(() => (mode.value === "mobile" ? 390 : 1024));
const stage = ref<HTMLElement>();
const stageWidth = ref(window.innerWidth - 48);
const windowHeight = ref(window.innerHeight);
const border = computed(() => (mode.value === "mobile" ? 6 : 1));
const scale = computed(() =>
  Math.min(1, Math.max(1, stageWidth.value) / (width.value + border.value * 2)),
);
const height = computed(() =>
  mode.value === "mobile" ? 780 : Math.max(600, windowHeight.value - 200),
);
const frameStyle = computed(() => ({
  width: `${(width.value + border.value * 2) * scale.value}px`,
  height: `${(height.value + border.value * 2) * scale.value}px`,
}));
const deviceStyle = computed(() => ({
  width: `${width.value}px`,
  height: `${height.value}px`,
  transform: `scale(${scale.value})`,
}));
const zoomLabel = computed(() =>
  scale.value < 1
    ? message("mailPreview.zoom", { percent: Math.round(scale.value * 100) })
    : "",
);
const widthLabel = computed(() =>
  message("mailPreview.width", { width: width.value }),
);
const sampleLabel = computed(() =>
  snapshot.value?.sample === undefined
    ? ""
    : message("mailPreview.sample", { row: snapshot.value.sample + 1 }),
);
let cleanup: (() => void) | undefined;
let observer: ResizeObserver | undefined;
watch(
  stage,
  (element) => {
    observer?.disconnect();
    if (!element) return;
    const padding = getComputedStyle(element);
    stageWidth.value =
      element.clientWidth -
      parseFloat(padding.paddingLeft) -
      parseFloat(padding.paddingRight);
    observer = new ResizeObserver(([entry]) => {
      stageWidth.value = entry!.contentRect.width;
    });
    observer.observe(element);
  },
  { flush: "post" },
);
function resize() {
  windowHeight.value = window.innerHeight;
}
const originalDark = document.documentElement.classList.contains("dark");
onMounted(() => {
  window.addEventListener("resize", resize);
  cleanup = receiveMailPreview(
    (content) => {
      snapshot.value = content;
      setLocale(content.locale);
      document.title = `${copy.value.title} · ${content.subject}`;
      document.documentElement.classList.toggle("dark", !!content.dark);
    },
    () => {
      expired.value = true;
    },
  );
});
onUnmounted(() => {
  cleanup?.();
  observer?.disconnect();
  window.removeEventListener("resize", resize);
  document.documentElement.classList.toggle("dark", originalDark);
});
function close() {
  window.close();
}
</script>

<template>
  <main class="mail-preview-page">
    <header class="mail-preview-header">
      <div class="mail-preview-heading">
        <Mail :size="22" />
        <div>
          <h1>{{ copy.title }}</h1>
          <p v-if="snapshot" class="muted">{{ snapshot.subject }}</p>
        </div>
      </div>
      <div class="mail-preview-tools">
        <Tabs v-model="mode">
          <TabsList :aria-label="copy.device">
            <TabsTrigger value="desktop"
              ><Monitor :size="16" />{{ copy.desktop }}</TabsTrigger
            >
            <TabsTrigger value="mobile"
              ><Smartphone :size="16" />{{ copy.mobile }}</TabsTrigger
            >
          </TabsList>
        </Tabs>
        <span class="mail-preview-size muted text-xs"
          >{{ widthLabel }}<small v-if="zoomLabel">{{ zoomLabel }}</small></span
        >
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="copy.close"
          @click="close"
          ><X :size="18"
        /></Button>
      </div>
    </header>
    <div class="mail-preview-note">
      <span>{{ copy.hint }}</span>
      <span v-if="sampleLabel">{{ sampleLabel }}</span>
    </div>
    <section
      v-if="snapshot"
      ref="stage"
      class="mail-preview-stage"
      :aria-label="copy.body"
    >
      <div class="mail-preview-fit" :style="frameStyle">
        <div
          class="mail-preview-device"
          :class="{ 'mail-preview-mobile': mode === 'mobile' }"
          :style="deviceStyle"
        >
          <iframe
            sandbox=""
            referrerpolicy="no-referrer"
            :title="copy.body"
            :srcdoc="previewDocument(snapshot.html)"
          />
        </div>
      </div>
    </section>
    <div v-else class="mail-preview-empty" :aria-busy="!expired">
      <h2>{{ expired ? copy.expired : copy.loading }}</h2>
      <p v-if="expired" class="muted">{{ copy.reopen }}</p>
    </div>
  </main>
</template>
