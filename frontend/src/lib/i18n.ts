import { computed, type ComputedRef } from "vue";
import { createI18n } from "vue-i18n";
import zh from "../locales/zh.json";
import en from "../locales/en.json";

export type Locale = "zh" | "en";
export type Messages = typeof en;
type MessageKeys<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : `${K}.${MessageKeys<T[K]>}`;
}[keyof T & string];
export type MessageKey = MessageKeys<Messages>;
export const i18n = createI18n({
  legacy: false,
  locale: "zh",
  fallbackLocale: "en",
  messages: { zh, en },
});

export function message(
  key: MessageKey,
  values: Record<string, string | number> = {},
) {
  return i18n.global.t(key, values);
}

/** Resolve copy reactively in script; templates bind the resulting properties. */
export function useMessages<Scope extends keyof Messages>(
  scope: Scope,
): ComputedRef<Messages[Scope]> {
  return computed(() => {
    const resolve = (node: object, prefix: string): object =>
      Object.fromEntries(
        Object.entries(node).map(([key, value]) => {
          const path = `${prefix}.${key}`;
          return [
            key,
            typeof value === "string"
              ? message(path as MessageKey)
              : resolve(value, path),
          ];
        }),
      );
    return resolve(en[scope], scope) as Messages[Scope];
  });
}

export function setLocale(value: string) {
  const locale: Locale = value === "en" ? "en" : "zh";
  i18n.global.locale.value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    document.title = message("app.omniMail");
  }
  try {
    localStorage.setItem("omnimail-language", locale);
  } catch {}
  return locale;
}

export function savedLocale(): Locale {
  try {
    return localStorage.getItem("omnimail-language") === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function isDefaultDraftTitle(title: string) {
  return [
    zh.workspaceView.untitledEmail,
    en.workspaceView.untitledEmail,
    zh.workspaceView.untitledEvent,
    en.workspaceView.untitledEvent,
  ].includes(title);
}

/** Task failure keys remain stable as the selected display language changes. */
export function taskError(item?: {
  error?: string;
  errorKey?: string;
  errorValues?: Record<string, string | number>;
}) {
  if (!item) return "";
  const key = item.errorKey?.replace(/^tasks\./, "");
  return key && Object.hasOwn(en.taskErrors, key)
    ? message(`taskErrors.${key}` as MessageKey, item.errorValues)
    : item.error || "";
}
