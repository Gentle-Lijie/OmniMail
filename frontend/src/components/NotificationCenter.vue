<script setup lang="ts">
import { useMessages } from "@/lib/i18n";
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

const copy = useMessages("notificationCenter");
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
  "--nv-width": "100%",
  "--nv-icon-size": "20px",
  "--nv-y-align": "start",
  "--nv-y-align-has-title": "start",
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
  list: modal.value
    ? {
        position: "relative" as const,
        inset: "auto",
        margin: "0",
        width: "100%",
        maxWidth: "100%",
        maxHeight: "min(240px, 30dvh)",
        flexDirection: "column" as const,
        justifyContent: "flex-start",
        flexShrink: 0,
        overflowY: "auto" as const,
        overflowX: "hidden" as const,
        clipPath: "none",
        zIndex: 100,
      }
    : {
        position: "fixed" as const,
        top: "76px",
        bottom: "12px",
        left: "auto",
        right: "12px",
        width: "380px",
        maxWidth: "calc(100% - 24px)",
        overflowY: "auto" as const,
        overflowX: "hidden" as const,
        clipPath: "none",
        zIndex: 100,
      },
  listItem: modal.value
    ? {
        position: "relative" as const,
        transform: "none",
        top: "auto",
        bottom: "auto",
        transition: "none",
        flexShrink: 0,
      }
    : {},
  itemContainer: {
    width: "100%",
    minWidth: "0",
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
  <Notivue v-slot="item" :styles="styles" :list-aria-label="copy.notifications">
    <Notification
      :item="item"
      :theme="theme"
      :icons="icons"
      hide-close
      class="notification-card"
      :class="{ 'notification-card-pending': item.type === 'promise' }"
    >
      <Button
        v-if="item.type !== 'promise'"
        type="button"
        variant="ghost"
        size="icon-sm"
        class="notification-close"
        :aria-label="copy.dismissNotification"
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
