import test from "node:test";
import assert from "node:assert/strict";
import {
  i18n,
  message,
  setLocale,
  useMessages,
  taskError,
} from "../src/lib/i18n.ts";
import { mergeIssues } from "../src/lib/mailMerge.ts";
import { api, setCsrf } from "../src/lib/api.ts";
import en from "../src/locales/en.json";
import zh from "../src/locales/zh.json";

function leaves(catalog: object, prefix = ""): Record<string, string> {
  return Object.assign(
    {},
    ...Object.entries(catalog).map(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === "string"
        ? { [path]: value }
        : leaves(value, path);
    }),
  );
}

test("locale catalogs have identical keys and matching named parameters", () => {
  const english = leaves(en),
    chinese = leaves(zh);
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const [key, value] of Object.entries(english)) {
    const params = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(params(chinese[key]), params(value), key);
    for (const locale of ["en", "zh"] as const) {
      setLocale(locale);
      assert.notEqual(
        i18n.global.t(key, { name: "Demo", count: 2, column: "email" }),
        key,
      );
    }
  }
});

test("script copy, nested statuses and validation react to language changes", () => {
  setLocale("en");
  const copy = useMessages("app");
  assert.equal(copy.value.workspace, "Workspace");
  assert.equal(copy.value.statuses.queued, "Queued");
  setLocale("zh");
  assert.equal(copy.value.workspace, "工作台");
  assert.equal(copy.value.statuses.queued, "排队中");
  assert.equal(
    mergeIssues("email", { to: "", subject: "", html: "" }, [], {})[0].message,
    "请填写收件人",
  );
  setLocale("en");
  assert.equal(
    mergeIssues("email", { to: "", subject: "", html: "" }, [], {})[0].message,
    "Recipient required",
  );
});

test("named parameters preserve user text and locale literals preserve merge-field syntax", () => {
  setLocale("zh");
  assert.equal(
    message("workspaceView.emailColumnConfirmed", { column: "customer.email" }),
    "已确认邮箱列「customer.email」。可插入字段并检查整批个性化内容。",
  );
  setLocale("en");
  assert.equal(
    message("aiProviderSettings.deleteService", {
      name: "Team @ work | {{name}}",
    }),
    "Delete Team @ work | {{name}}",
  );
  assert.equal(
    message("aiProviderSettings.customHeadersClearsPreviousValues"),
    "Custom headers · {} clears previous values",
  );
});

test("API requests carry the selected locale and local network failures are localized", async () => {
  const originalFetch = globalThis.fetch;
  try {
    setLocale("zh");
    setCsrf("test");
    globalThis.fetch = async (_url, options) => {
      assert.equal(
        (options?.headers as Record<string, string>)["Accept-Language"],
        "zh",
      );
      return Response.json({ ok: true });
    };
    assert.deepEqual(await api("/settings"), { ok: true });
    globalThis.fetch = async () => {
      throw Error("offline");
    };
    await assert.rejects(api("/settings"), /无法连接 API/);
    setLocale("en");
    await assert.rejects(api("/settings"), /Cannot reach API/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Vue templates bind localized copy without inline translations or hardcoded UI text", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { parse } = await import("@vue/compiler-sfc");
  const { parse: parseTemplate } = await import("@vue/compiler-dom");
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)],
    );
  for (const file of files(root).filter((file) => file.endsWith(".vue"))) {
    const template = parse(readFileSync(file, "utf8")).descriptor.template
      ?.content;
    if (!template) continue;
    assert.doesNotMatch(template, /\b(?:t|translate|message)\s*\(/, file);
    const walk = (node: any) => {
      if (node.type === 2)
        assert.doesNotMatch(node.content, /[a-zA-Z\p{Script=Han}]/u, file);
      if (node.type === 1) {
        for (const prop of node.props) {
          if (
            prop.type === 6 &&
            ["label", "title", "placeholder", "aria-label", "alt"].includes(
              prop.name,
            ) &&
            prop.value
          )
            assert.doesNotMatch(
              prop.value.content,
              /[a-zA-Z\p{Script=Han}]/u,
              file,
            );
        }
      }
      for (const child of node.children || []) walk(child);
    };
    walk(parseTemplate(template));
  }
});

test("already loaded task failures update when the display locale changes", () => {
  const item = {
    error: "Webhook is not configured",
    errorKey: "tasks.webhookIsNotConfigured",
  };
  setLocale("en");
  assert.equal(taskError(item), "Webhook is not configured");
  setLocale("zh");
  assert.equal(taskError(item), "尚未配置 Webhook");
  assert.equal(taskError({ error: "External details" }), "External details");
});
