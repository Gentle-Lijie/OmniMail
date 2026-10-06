import test from "node:test";
import assert from "node:assert/strict";
import { draftContentSchema, createDrafts, DraftError } from "./drafts.js";
import { repairDraftRecipients } from "./recipientRepair.js";
import { findRecipientIssues } from "./recipients.js";
import { createStore, hash } from "./store.js";
import { createTasks } from "./tasks.js";
import { createAgentTools } from "./agentTools.js";
import { buildApp } from "./app.js";
const secret = "recipient-repair-secret-at-least-32-characters";
const content = (rows: any[] = []) =>
  draftContentSchema.parse({
    kind: "email",
    title: "Repair",
    payload: {
      to: rows.length ? "{{Email}}" : "single@example.com",
      cc: "copy@example.com",
      bcc: "",
      subject: "Hello {{Name}}",
      html: "<p>{{Name}}</p>",
    },
    rows,
    columns: rows.length ? ["Email", "Name"] : [],
    mapping: rows.length ? { Email: "Email", Name: "Name" } : {},
    recipientColumn: rows.length ? "Email" : "",
    manualTo: "original@example.com",
  });
const rows = [
  { Email: "  Ｆirst＠ＥＸＡＭＰＬＥ．ＣＯＭ  ", Name: "First <b>person</b>" },
  { Email: "first@example.com", Name: "Duplicate different content" },
  { Email: "first@example.com;second@example.com", Name: "Mixed" },
  { Email: "bad@@example.com", Name: "Unresolved" },
  { Email: "", Name: "Missing" },
];

test("repairs width, whitespace, separators and domain casing, preserving local casing and invalid values", () => {
  const draft = content();
  draft.payload = {
    to: "Ｕser＠ＥＸＡＭＰＬＥ．ＣＯＭ；User@example.com",
    cc: "copy@EXAMPLE.COM;USER@example.com",
    bcc: "bad@@example.com;<>",
    subject: "Unrelated user@example.com",
    html: "<p>User@example.com</p>",
  };
  const original = structuredClone(draft),
    result = repairDraftRecipients(draft);
  assert.equal(result.draft.payload.to, "User@example.com");
  assert.equal(result.draft.payload.cc, "copy@example.com");
  assert.equal(result.draft.payload.bcc, "bad@@example.com;<>");
  assert.equal(result.report.duplicateAddresses, 2);
  assert(result.report.unresolvedCount >= 1);
  assert.equal(result.draft.payload.subject, draft.payload.subject);
  assert.equal(result.draft.payload.html, draft.payload.html);
  assert.deepEqual(draft, original);
});
test("batch repair keeps first targets and nonduplicate targets in mixed cells; unresolved and empty rows remain", () => {
  const draft = content(rows),
    original = structuredClone(draft),
    result = repairDraftRecipients(draft);
  assert.equal(result.report.removedRows, 1);
  assert.equal(result.report.duplicateAddresses, 2);
  assert.deepEqual(
    result.draft.rows.map((row) => row.Email),
    ["First@example.com", "second@example.com", "bad@@example.com", ""],
  );
  assert.deepEqual(
    result.draft.rows.map((row) => row.Name),
    [rows[0].Name, rows[2].Name, rows[3].Name, rows[4].Name],
  );
  assert.equal(result.draft.payload.cc, "copy@example.com");
  assert.equal(result.report.unresolvedCount, 2);
  assert.deepEqual(draft, original);
});
test("user supplied replacement repairs invalid addresses; invalid replacement and unknown exclusion cannot mutate input", () => {
  const draft = content([{ Email: "bad@@example.com", Name: "Name" }]);
  const replaced = repairDraftRecipients(draft, {
    replacements: { "BAD@@EXAMPLE.COM": "correct@example.com" },
  });
  assert.equal(replaced.draft.rows[0].Email, "correct@example.com");
  assert.equal(replaced.report.unresolvedCount, 0);
  assert.throws(() =>
    repairDraftRecipients(draft, {
      replacements: { "bad@@example.com": "still invalid" },
    }),
  );
  assert.throws(() => repairDraftRecipients(draft, { excludeRows: [5] }));
  assert.equal(draft.rows[0].Email, "bad@@example.com");
  const excluded = repairDraftRecipients(draft, { excludeRows: [0] });
  assert.equal(excluded.draft.rows.length, 0);
  assert.equal(excluded.draft.payload.to, "");
  assert.equal(excluded.draft.manualTo, "");
});
test("complex recipient expressions are retained and repeated copy targets across messages or attendees across events are intentional", () => {
  const draft = content([
    { Email: "same@example.com", Name: "One" },
    { Email: "different@example.com", Name: "Two" },
  ]);
  draft.payload.to = "{{Email}};extra@example.com";
  const result = repairDraftRecipients(draft);
  assert.deepEqual(result.draft.rows, draft.rows);
  assert(result.report.unsupportedFields.includes("to"));
  const calendar = draftContentSchema.parse({
    kind: "event",
    payload: {
      requiredAttendees: "{{Email}}",
      optionalAttendees: "optional@example.com",
    },
    rows: [{ Email: "same@example.com" }, { Email: "SAME@example.com" }],
    columns: ["Email"],
    mapping: { Email: "Email" },
    recipientColumn: "Email",
  });
  assert.equal(repairDraftRecipients(calendar).draft.rows.length, 2);
  assert.deepEqual(
    findRecipientIssues(
      "email",
      { to: "one@example.com", cc: "copy@example.com" },
      new Set(),
    ),
    [],
  );
  assert.deepEqual(
    findRecipientIssues(
      "email",
      { to: "two@example.com", cc: "copy@example.com" },
      new Set(),
    ),
    [],
  );
  assert(
    findRecipientIssues("email", {
      to: "one@example.com",
      cc: "ONE@example.com",
    }).some((issue) => issue.code === "duplicate_recipient"),
  );
  assert(
    findRecipientIssues("email", { to: "one@example.com", bcc: "<>" }).some(
      (issue) => issue.code === "invalid_recipient",
    ),
  );
});
test("preview is read-only, application supports undo across body/conversation edits and invalidates old reviews", () => {
  const store = createStore(":memory:", secret);
  try {
    const drafts = createDrafts(store),
      tasks = createTasks(store);
    const original = drafts.create(content(rows));
    const preview = drafts.repair(original.id, 1, {}, true);
    assert.equal(preview.report.removedRows, 1);
    assert.deepEqual(drafts.get(original.id), original);
    const repaired = drafts.repair(original.id, 1);
    assert("draft" in repaired);
    const after = repaired.draft!;
    assert.equal(after.revision, 2);
    assert.equal(after.undoRevision, 2);
    assert.equal(tasks.list().length, 0);
    const edited = drafts.update(after.id, 2, {
      ...drafts.content(after),
      payload: { ...after.payload, html: "<p>Later body</p>" },
      conversation: [{ role: "user", content: "Later conversation" }],
    });
    assert.equal(edited.undoRevision, 3);
    const restored = drafts.undoRepair(edited.id, 3);
    assert.deepEqual(restored.rows, original.rows);
    assert.equal(restored.payload.html, "<p>Later body</p>");
    assert.equal(restored.conversation[0].content, "Later conversation");
    assert.equal(restored.undoRevision, undefined);
    assert.throws(() => drafts.undoRepair(restored.id, restored.revision));
    const valid = drafts.create({
      ...content([{ Email: "one@example.com", Name: "One" }]),
      payload: {
        to: "{{Email}}",
        cc: "",
        bcc: "",
        subject: "Subject",
        html: "Body",
      },
    });
    const review = drafts.review(valid.id, 1);
    const repairedValid = drafts.repair(valid.id, 1, {
      replacements: { "one@example.com": "two@example.com" },
    });
    assert("draft" in repairedValid);
    assert.throws(() => tasks.confirm(review.id));
    assert.equal(tasks.get(review.id).status, "draft");
  } finally {
    store.db.close();
  }
});
test("undo and repair reject stale revisions or subsequent recipient/batch edits without discarding newer data", () => {
  const store = createStore(":memory:", secret);
  try {
    const drafts = createDrafts(store),
      original = drafts.create(content(rows));
    const result = drafts.repair(original.id, 1);
    assert("draft" in result);
    const repaired = result.draft!;
    assert.throws(() => drafts.repair(original.id, 1), DraftError);
    const edited = drafts.update(repaired.id, 2, {
      ...drafts.content(repaired),
      rows: repaired.rows.map((row, index) =>
        index === 0 ? { ...row, Name: "Later cell edit" } : row,
      ),
    });
    assert.equal(edited.undoRevision, undefined);
    assert.throws(() => drafts.undoRepair(edited.id, 3), DraftError);
    assert.equal(drafts.get(edited.id).rows[0].Name, "Later cell edit");
    const cleared = drafts.repair(edited.id, 3, {
      excludeRows: edited.rows.map((_, index) => index),
    });
    assert("draft" in cleared);
    assert.throws(() => drafts.review(edited.id, cleared.draft!.revision));
    assert.equal(createTasks(store).list().length, 0);
  } finally {
    store.db.close();
  }
});
test("Agent repair synchronizes server rows, reports and undo with revisions without exposing unrelated row values", () => {
  const store = createStore(":memory:", secret);
  try {
    const drafts = createDrafts(store),
      original = drafts.create(content(rows));
    const events: any[] = [];
    const tools = createAgentTools(store, {
      workspace: {
        draftId: original.id,
        kind: original.kind,
        payload: original.payload,
        mapping: original.mapping,
        recipientColumn: original.recipientColumn,
        revision: 1,
      },
      serverDraft: original,
      rows: original.rows,
      columns: original.columns,
      attachments: [],
      conversation: [],
      onProgress: (event) => events.push(event),
    });
    const preview = tools.execute("repair_current_draft", {
      expectedRevision: 1,
    }) as any;
    assert.equal(preview.report.removedRows, 1);
    assert.equal(drafts.get(original.id).revision, 1);
    const result = tools.execute("repair_current_draft", {
      expectedRevision: 1,
      preview: false,
    }) as any;
    assert.equal(result.revision, 2);
    assert(!JSON.stringify(result).includes("Duplicate different content"));
    assert.equal(
      (tools.execute("get_batch_schema", {}) as any).rowCount ??
        (tools.execute("get_batch_schema", {}) as any).count,
      4,
    );
    assert(
      events.some(
        (event) => event.type === "workspace" && event.batch?.rows.length === 4,
      ),
    );
    tools.execute("undo_current_draft_repair", { expectedRevision: 2 });
    assert.deepEqual(drafts.get(original.id).rows, original.rows);
    assert.equal(createTasks(store).list().length, 0);
  } finally {
    store.db.close();
  }
});
test("repair endpoints enforce CSRF and revision; previews, replacements and undo never queue", async () => {
  const { app, store } = await buildApp({
    secret,
    setupToken: "repair-tests",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
  });
  store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash("repair-session"),
      JSON.stringify({ authenticated: true, csrfToken: "token" }),
      Date.now() + 60000,
    );
  const drafts = createDrafts(store),
    draft = drafts.create(content(rows));
  const headers = {
    cookie: "omnimail=repair-session",
    origin: "http://localhost:5173",
    "x-csrf-token": "token",
  };
  try {
    assert.equal(
      (
        await app.inject({
          url: `/api/drafts/${draft.id}/repair`,
          method: "POST",
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/drafts/${draft.id}/repair`,
          method: "POST",
          headers: { cookie: headers.cookie },
          payload: { expectedRevision: 1 },
        })
      ).statusCode,
      403,
    );
    const preview = await app.inject({
      url: `/api/drafts/${draft.id}/repair`,
      method: "POST",
      headers,
      payload: { expectedRevision: 1, preview: true },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(drafts.get(draft.id).revision, 1);
    const applied = await app.inject({
      url: `/api/drafts/${draft.id}/repair`,
      method: "POST",
      headers,
      payload: { expectedRevision: 1 },
    });
    assert.equal(applied.statusCode, 200);
    const stale = await app.inject({
      url: `/api/drafts/${draft.id}/repair`,
      method: "POST",
      headers,
      payload: { expectedRevision: 1 },
    });
    assert.equal(stale.statusCode, 409);
    const undone = await app.inject({
      url: `/api/drafts/${draft.id}/undo-repair`,
      method: "POST",
      headers,
      payload: { expectedRevision: 2 },
    });
    assert.equal(undone.statusCode, 200);
    assert.deepEqual(undone.json().rows, draft.rows);
    assert.equal(createTasks(store).list().length, 0);
  } finally {
    await app.close();
  }
});

test("dangling malformed fragments remain visible and unresolved rather than disappearing during repair", () => {
  const draft = content();
  draft.payload.to = "good@example.com;<";
  const result = repairDraftRecipients(draft);
  assert.equal(result.draft.payload.to, "good@example.com;<");
  assert.equal(result.report.unresolvedCount, 1);
  assert(
    findRecipientIssues("email", result.draft.payload).some(
      (issue) => issue.code === "invalid_recipient",
    ),
  );
});

test("tool-enabled AI uses authoritative server rows and streams repaired batch state without sending private names to the model", async () => {
  const { createAI } = await import("./ai.js");
  const store = createStore(":memory:", secret);
  try {
    const drafts = createDrafts(store);
    const original = drafts.create(
      content([
        {
          Email: "Ｆirst＠ＥＸＡＭＰＬＥ．ＣＯＭ",
          Name: "private-name-never-in-model-input",
        },
        { Email: "first@example.com", Name: "private-duplicate-name" },
      ]),
    );
    let round = 0;
    const events: any[] = [];
    const ai = createAI(store, (async (_url, options) => {
      const body = String(options?.body);
      assert(!body.includes("private-name-never-in-model-input"));
      assert(!body.includes("private-duplicate-name"));
      round++;
      const call =
        round === 1
          ? {
              name: "repair_current_draft",
              args: { expectedRevision: 1, preview: false },
            }
          : {
              name: "submit_draft",
              args: {
                kind: "email",
                message: "Recipients repaired",
                payload: {},
              },
            };
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call-" + round,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    }) as typeof fetch);
    ai.save({
      name: "Isolated fake",
      protocol: "openai-chat",
      baseUrl: "https://model.invalid/v1",
      model: "fake",
      apiKey: "fake",
      outputMode: "prompt",
    });
    const result = await ai.agent(
      {
        message: "Repair recipients",
        draftId: original.id,
        serverRevision: 1,
        kind: "email",
        payload: {
          to: "stale@example.com",
          subject: "Stale browser field",
          html: "Stale body",
        },
      },
      { onProgress: (event) => events.push(event) },
    );
    assert.equal(round, 2);
    assert.equal(result.workspaceChanged, true);
    assert.equal(result.workspace.revision, 2);
    assert.equal(drafts.get(original.id).rows.length, 1);
    assert.equal(
      drafts.get(original.id).payload.subject,
      original.payload.subject,
    );
    assert(
      events.some(
        (event) => event.type === "workspace" && event.batch?.rows.length === 1,
      ),
    );
    assert.equal(createTasks(store).list().length, 0);
  } finally {
    store.db.close();
  }
});
