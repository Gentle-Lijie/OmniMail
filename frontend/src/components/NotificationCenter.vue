<script setup lang="ts">
import {
  computed,
  defineComponent,
  h,
  markRaw,
  onMounted,
  onUnmounted,
  ref,
  type Component,
} from "vue";
import {
  Notivue,
  Notification,
  lightTheme,
  useNotivue,
  type NotivueIcons,
  type NotivueTheme,
} from "notivue";
import {
  CheckCircle2,
  AlertCircle,
  TriangleAlert,
  Info,
  LoaderCircle,
  X,
} from "lucide-vue-next";
import { Button } from "./ui/button";
import type { NotificationAction } from "@/lib/notifications";
defineProps<{ t: (zh: string, en: string) => string }>();
const icon = (component: Component, spinning = false) =>
  markRaw(
    defineComponent({
      setup: () => () =>
        h(component, {
          size: 20,
          class: spinning ? "animate-spin" : undefined,
        }),
    }),
  );
const icons: NotivueIcons = {
  success: icon(CheckCircle2),
  error: icon(AlertCircle),
  warning: icon(TriangleAlert),
  info: icon(Info),
  promise: icon(LoaderCircle, true),
  "promise-resolve": icon(CheckCircle2),
  "promise-reject": icon(AlertCircle),
  close: icon(X),
};
const theme: NotivueTheme = {
  ...lightTheme,
  "--nv-global-bg": "var(--card)",
  "--nv-global-fg": "var(--foreground)",
  "--nv-global-border": "var(--border)",
  "--nv-border-width": "1px",
  "--nv-radius": "12px",
  "--nv-width": "380px",
  "--nv-message-size": "13px",
  "--nv-success-accent": "var(--success)",
  "--nv-error-accent": "var(--notification-error)",
  "--nv-warning-accent": "var(--notification-warning)",
  "--nv-info-accent": "var(--primary)",
  "--nv-promise-accent": "var(--primary)",
};
const { teleportTo } = useNotivue();
const modal = ref(false);
const styles = computed(() => ({
  list: {
    position: modal.value ? ("absolute" as const) : ("fixed" as const),
    top: modal.value ? "12px" : "76px",
    bottom: "12px",
    left: "auto",
    right: "12px",
    width: "380px",
    maxWidth: "calc(100% - 24px)",
    zIndex: 100,
  },
}));
let observer: MutationObserver | undefined;
function syncTarget() {
  const dialogs = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-state="open"]',
  );
  const target = dialogs[dialogs.length - 1];
  modal.value = !!target;
  if (teleportTo.value !== (target || "body"))
    teleportTo.value = target || "body";
}
onMounted(() => {
  observer = new MutationObserver(syncTarget);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
  syncTarget();
});
onUnmounted(() => {
  observer?.disconnect();
  teleportTo.value = "body";
});
const actionOf = (props: Record<string, unknown>) =>
  props.action as NotificationAction | undefined;
</script>
<template>
  <Notivue
    v-slot="item"
    :styles="styles"
    :list-aria-label="t('通知', 'Notifications')"
  >
    <Notification
      :item="item"
      :theme="theme"
      :icons="icons"
      hide-close
      class="notification-card"
    >
      <Button
        v-if="item.type !== 'promise'"
        type="button"
        variant="ghost"
        size="icon-sm"
        class="notification-close"
        :aria-label="t('关闭通知', 'Dismiss notification')"
        @click="item.clear"
        ><X :size="16"
      /></Button>
      <Button
        v-if="actionOf(item.props)"
        type="button"
        variant="outline"
        size="sm"
        class="notification-action"
        :disabled="actionOf(item.props)?.disabled?.()"
        @click="actionOf(item.props)?.run()"
        >{{ actionOf(item.props)?.label }}</Button
      >
    </Notification>
  </Notivue>
</template>
