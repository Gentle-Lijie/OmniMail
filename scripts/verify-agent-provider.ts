// Opt-in real provider verification. Copies encrypted provider config only into
// an in-memory database, with no webhooks and no worker; never sends mail.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createStore } from "../server/store.js";
import { createAI } from "../server/ai.js";
import { createTemplates } from "../server/templates.js";
import { withLocale } from "../server/i18n.js";

if (existsSync(".env")) loadEnvFile(".env");
const secret = process.env.APP_SECRET ?? "";
const source = createStore(
  process.env.DATABASE_PATH ?? "data/omnimail.sqlite",
  secret,
);
const store = createStore(":memory:", secret);
for (const row of source.db.prepare("SELECT id,value FROM providers").all() as {
  id: string;
  value: string;
}[])
  store.db.prepare("INSERT INTO providers VALUES (?,?)").run(row.id, row.value);
store.set("defaultProviderId", source.get("defaultProviderId", ""));
source.db.close();
const ai = createAI(store);
const templates = createTemplates(store);
const seed = templates.create({
  name: "隔离验收模板",
  kind: "email",
  subject: "给 {{姓名}} 的会议通知",
  html: "<p>{{姓名}}，请确认参会。</p>",
  fields: ["姓名"],
});
const allCalls = new Set<string>();
const progress = (event: any) => {
  if (event.type === "tool" && event.tool.status !== "running") {
    if (event.tool.status === "complete") allCalls.add(event.tool.name);
    console.log(
      JSON.stringify({ tool: event.tool.name, status: event.tool.status }),
    );
  }
};
const original = {
  to: "scylz12@nottingham.edu.cn",
  cc: "",
  bcc: "",
  subject: "隔离验收",
  html: "<p>原草稿</p>",
};
try {
  await withLocale("zh", () =>
    ai.agent(
      {
        kind: "email",
        draftId: "isolated-template",
        payload: original,
        message: `请使用实际工具：查询“隔离验收模板”，读取其详情，把主题改成“会议安排 {{姓名}}”保存为新版本，然后查看历史版本，再恢复第 1 版。不要修改当前草稿，不发送。目标 ID 为 ${seed.id}。`,
      },
      { onProgress: progress },
    ),
  );
  const restored = templates.get(seed.id);
  assert.equal(restored.version, 3);
  assert.equal(restored.subject, seed.subject);
  const batch = await withLocale("zh", () =>
    ai.agent(
      {
        kind: "email",
        draftId: "isolated-batch",
        payload: original,
        columns: ["Email", "Name"],
        rows: [{ Email: "scylz12@nottingham.edu.cn", Name: "林悦" }],
        message: `请实际读取当前草稿和名单结构，读取第 0 行，再应用模板 ${seed.id}，把“姓名”映射到 Name，明确选择 Email 为收件人列，校验草稿，预览第 0 行，保存草稿，然后查询保存任务详情，准备执行摘要，最后请求人工执行确认。不要实际发送或排队。`,
      },
      { onProgress: progress },
    ),
  );
  assert.equal(batch.workspace.recipientColumn, "Email");
  assert.equal(batch.workspace.mapping["姓名"], "Name");
  assert(batch.reviewTaskId);
  const saved = JSON.parse(
    (
      store.db
        .prepare("SELECT value FROM tasks WHERE id=?")
        .get(batch.reviewTaskId) as { value: string }
    ).value,
  );
  assert.equal(saved.status, "draft");
  assert.equal(saved.items[0].payload.to, "scylz12@nottingham.edu.cn");
  assert.equal(saved.items[0].payload.html, "<p>林悦，请确认参会。</p>");
  const reference = await withLocale("zh", () =>
    ai.agent(
      {
        kind: "email",
        draftId: "isolated-reference",
        payload: original,
        attachments: [
          {
            kind: "text",
            name: "reference.txt",
            size: 100,
            text: "项目交付期限为2026年10月12日。付款期限为2026年10月20日。",
          },
        ],
        message:
          "请先搜索附件中的‘交付期限’，再读取命中文档的内容，然后使用工具把当前草稿主题改为‘交付提醒’，正文改为包含真实交付日期的简短提醒。读取和修改草稿要使用工具，不发送。",
      },
      { onProgress: progress },
    ),
  );
  assert.equal(reference.workspace.payload.subject, "交付提醒");
  assert(reference.workspace.payload.html.includes("12"));
  await withLocale("zh", () =>
    ai.agent(
      {
        kind: "email",
        draftId: "isolated-cleanup",
        payload: original,
        message: `请用工具查询所有 draft 任务，读取任务 ${saved.id} 并取消它；然后创建一个名称为“临时清理验收”的邮件模板，读取刚创建模板的版本并删除它。不要删除“隔离验收模板”。不要发送。`,
      },
      { onProgress: progress },
    ),
  );
  assert.equal(
    JSON.parse(
      (
        store.db
          .prepare("SELECT value FROM tasks WHERE id=?")
          .get(saved.id) as { value: string }
      ).value,
    ).status,
    "cancelled",
  );
  assert.equal(templates.list().length, 1);
  assert.equal(
    (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE json_extract(value,'$.status')='queued'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    allCalls.size,
    23,
    "All business tools must complete in the real provider smoke test.",
  );
  console.log(
    JSON.stringify({
      ok: true,
      provider: ai.list().find((p) => p.id === ai.defaultProviderId())?.name,
      toolsExercised: allCalls.size,
      tools: [...allCalls].sort(),
      queued: 0,
    }),
  );
} finally {
  store.db.close();
}
