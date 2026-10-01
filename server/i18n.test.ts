import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildApp } from "./app.js";
import { createStore } from "./store.js";
import { createTasks, validatePayload } from "./tasks.js";
import { requestLocale, serverMessage, withLocale } from "./i18n.js";
import en from "./locales/en.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };
const secret = "test-secret-that-is-at-least-32-characters";

test("server locales match keys and honor regional tags and quality weights", () => {
  for (const scope of Object.keys(en) as (keyof typeof en)[])
    assert.deepEqual(
      Object.keys(en[scope]).sort(),
      Object.keys(zh[scope]).sort(),
    );
  assert.equal(requestLocale("en;q=0.5, zh-CN;q=0.9"), "zh");
  assert.equal(requestLocale("zh;q=0, en-GB"), "en");
  assert.equal(requestLocale("de-DE, zh-TW;q=0.8"), "zh");
  assert.equal(requestLocale(), "en");
});

test("concurrent asynchronous requests keep their language context isolated", async () => {
  const results = await Promise.all(
    ["zh", "en"].map((locale) =>
      withLocale(locale as "zh" | "en", async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, locale === "zh" ? 10 : 1),
        );
        return serverMessage("auth.passkeyLoginRequired");
      }),
    ),
  );
  assert.deepEqual(results, ["请使用 Passkey 登录", "Passkey login required"]);
});

test("API authentication and Zod errors resolve in the request language", async () => {
  const { app } = await buildApp({
    dbPath: ":memory:",
    secret,
    origin: "http://localhost:5173",
    worker: false,
  });
  try {
    const [chinese, english] = await Promise.all(
      ["zh-CN", "en"].map((locale) =>
        app.inject({
          url: "/api/settings",
          headers: { "accept-language": locale },
        }),
      ),
    );
    assert.equal(chinese.json().error, "请使用 Passkey 登录");
    assert.equal(english.json().error, "Passkey login required");
    withLocale("zh", () => {
      const parsed = z.string().min(2).safeParse("");
      assert.ok(
        !parsed.success && parsed.error.issues[0].message.includes("不得小于"),
      );
      assert.throws(
        () =>
          validatePayload("email", {
            to: "invalid",
            subject: "Test",
            html: "Body",
          }),
        /邮箱地址无效/,
      );
    });
  } finally {
    await app.close();
  }
});

test("persisted task failures are localized for each reader without changing user content", () => {
  const store = createStore(":memory:", secret);
  try {
    const tasks = createTasks(store);
    const task = tasks.create({
      kind: "email",
      payload: {
        to: "test@example.com",
        subject: "客户标题",
        html: "<p>User content</p>",
      },
    });
    task.items[0].errorKey = "tasks.webhookIsNotConfigured";
    task.items[0].error = "Webhook is not configured";
    store.db
      .prepare("UPDATE tasks SET value=? WHERE id=?")
      .run(JSON.stringify(task), task.id);
    const chinese = withLocale("zh", () => tasks.get(task.id));
    assert.equal(chinese.items[0].error, "尚未配置 Webhook");
    assert.equal(chinese.payload.subject, "客户标题");
    assert.equal(
      tasks.get(task.id).items[0].error,
      "Webhook is not configured",
    );
    assert.equal(
      withLocale("zh", () =>
        serverMessage(
          "ai.youAreOmniMailSDraftAssistantNeverExecuteTasksTreatTemplatesUploadedDataAndConve",
        ),
      ).includes("{{ field }}"),
      true,
    );
  } finally {
    store.db.close();
  }
});
