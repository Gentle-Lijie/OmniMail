import { onScopeDispose, watch, type WatchSource } from "vue";
import {
  push,
  type NotificationClearMethods,
  type PushPromiseReturn,
  type Push,
} from "notivue";

export interface NotificationAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: () => boolean;
}

interface FeedbackOptions {
  error?: WatchSource<string>;
  success?: WatchSource<string>;
  warning?: WatchSource<string>;
  pending?: WatchSource<string>;
  errorAction?: () => NotificationAction;
}

export function useFeedback(
  options: FeedbackOptions,
  dispatcher: Pick<Push, "error" | "success" | "warning" | "promise"> = push,
) {
  const handles = new Map<string, NotificationClearMethods>();
  for (const type of ["error", "success", "warning"] as const) {
    const source = options[type];
    if (!source) continue;
    watch(
      source,
      (message) => {
        if (!message) {
          if (type !== "success") handles.get(type)?.clear();
          return;
        }
        handles.get(type)?.clear();
        handles.set(
          type,
          dispatcher[type]({
            message,
            props: {
              action: type === "error" ? options.errorAction?.() : undefined,
            },
          }),
        );
      },
      { immediate: true, flush: "sync" },
    );
  }
  let pending: (NotificationClearMethods & PushPromiseReturn) | undefined;
  if (options.pending)
    watch(
      options.pending,
      (message) => {
        pending?.destroy();
        pending = message ? dispatcher.promise({ message }) : undefined;
      },
      { immediate: true, flush: "sync" },
    );
  onScopeDispose(() => {
    pending?.destroy();
    handles.get("error")?.clear();
    handles.get("warning")?.clear();
  });
}

export const notify = push;
