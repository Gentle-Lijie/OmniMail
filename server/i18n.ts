import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import en from "./locales/en.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };

type Locale = "zh" | "en";
type MessageKeys<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : `${K}.${MessageKeys<T[K]>}`;
}[keyof T & string];
export type ServerMessageKey = MessageKeys<typeof en>;
const context = new AsyncLocalStorage<Locale>();

export function requestLocale(header?: string): Locale {
  const preferred = (header || "")
    .split(",")
    .map((entry) => {
      const [tag, ...options] = entry.trim().split(";");
      const quality = options.find((option) => option.trim().startsWith("q="));
      return {
        tag: tag?.toLowerCase(),
        quality: quality ? Number(quality.trim().slice(2)) : 1,
      };
    })
    .filter((entry) => entry.quality > 0 && entry.quality <= 1)
    .sort((a, b) => b.quality - a.quality);
  for (const { tag } of preferred) {
    if (tag === "zh" || tag?.startsWith("zh-")) return "zh";
    if (tag === "en" || tag?.startsWith("en-")) return "en";
  }
  return "en";
}

export function withLocale<T>(locale: Locale, run: () => T): T {
  return context.run(locale, run);
}

export function serverMessage(
  key: ServerMessageKey,
  values: Record<string, string | number> = {},
): string {
  const lookup = (catalog: object) =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        catalog,
      );
  const template = lookup(context.getStore() === "zh" ? zh : en) ?? lookup(en);
  if (typeof template !== "string")
    throw new Error(`Unknown locale key: ${key}`);
  // Replace only supplied parameters; JSON examples and merge fields stay literal.
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}

z.setErrorMap((issue, original) => {
  if (context.getStore() !== "zh") return { message: original.defaultError };
  switch (issue.code) {
    case "invalid_type":
      return {
        message: serverMessage(
          issue.received === "undefined"
            ? "validation.required"
            : "validation.invalidType",
          { expected: issue.expected },
        ),
      };
    case "too_small":
      return {
        message: serverMessage("validation.tooSmall", {
          minimum: String(issue.minimum),
        }),
      };
    case "too_big":
      return {
        message: serverMessage("validation.tooBig", {
          maximum: String(issue.maximum),
        }),
      };
    case "invalid_string":
      return { message: serverMessage("validation.invalidString") };
    case "unrecognized_keys":
      return {
        message: serverMessage("validation.unrecognizedKeys", {
          keys: issue.keys.join(", "),
        }),
      };
    default:
      return { message: serverMessage("validation.invalidValue") };
  }
});
