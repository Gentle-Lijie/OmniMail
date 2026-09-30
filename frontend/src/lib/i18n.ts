import { createI18n } from "vue-i18n";
export const i18n = createI18n({
  legacy: false,
  locale: "zh",
  fallbackLocale: "en",
  missingWarn: false,
  fallbackWarn: false,
  messages: { zh: {}, en: {} },
});
const keys = new Map<string, string>();
export function translate(zh: string, en: string) {
  const pair = JSON.stringify([zh, en]);
  let key = keys.get(pair);
  if (!key) {
    key = `message_${keys.size}`;
    keys.set(pair, key);
    i18n.global.mergeLocaleMessage("zh", { [key]: () => zh });
    i18n.global.mergeLocaleMessage("en", { [key]: () => en });
  }
  return i18n.global.t(key);
}
