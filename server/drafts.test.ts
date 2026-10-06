import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, hash } from "./store.js";
import { createDrafts, DraftError } from "./drafts.js";
import { createTasks } from "./tasks.js";
import { buildApp } from "./app.js";
const secret = "draft-test-secret-at-least-32-characters";
const payload = {
  to: "recipient@example.com",
  cc: "",
  bcc: "",
  subject: "Hello {{Name}}",
  html: "<p>{{Name}}</p>",
};
const valid = {
  title: "Batch",
  kind: "email",
  payload,
  columns: ["Email", "Name"],
  rows: [
    { Email: "one@example.com", Name: "A&B" },
    { Email: "two@example.com", Name: "Two" },
  ],
  mapping: { Name: "Name" },
  recipientColumn: "Email",
};

test("incomplete drafts persist all editable state, reopen and update with optimistic concurrency", () => {
  const dir = mkdtempSync(join(tmpdir(), "omnimail-draft-")),
    path = join(dir, "test.sqlite");
  let store = createStore(path, secret);
  const service = createDrafts(store);
  const original = service.create(
    {
      kind: "email",
      title: "Incomplete",
      payload: { to: "", subject: "", html: "" },
      message: "continue",
      conversation: [
        {
          role: "user",
          content: "Please draft",
          attachments: [{ name: "ref.txt", size: 9 }],
        },
      ],
      attachments: [
        { kind: "text", name: "ref.txt", size: 9, text: "reference" },
      ],
    },
    "stable-id",
  );
  assert.equal(
    service.create(service.content(original), "stable-id").revision,
    1,
  );
  assert.equal(createTasks(store).list().length, 0);
  assert.throws(() => service.review(original.id, 1), DraftError);
  store.db.close();
  store = createStore(path, secret);
  try {
    const drafts = createDrafts(store),
      reopened = drafts.get(original.id);
    assert.deepEqual(reopened, original);
    const next = drafts.update(reopened.id, 1, {
      ...drafts.content(reopened),
      title: "Edited",
    });
    assert.equal(next.revision, 2);
    assert.equal(drafts.update(next.id, 2, drafts.content(next)).revision, 2);
    assert.throws(
      () =>
        drafts.update(next.id, 1, {
          ...drafts.content(original),
          title: "Stale",
        }),
      (e) => e instanceof DraftError && e.statusCode === 409,
    );
    assert.throws(() => drafts.remove(next.id, 1), DraftError);
    assert.equal(drafts.get(next.id).title, "Edited");
    assert.deepEqual(drafts.get(next.id).attachments, reopened.attachments);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("whole-batch review produces an escaped immutable snapshot and stale versions cannot queue", () => {
  const store = createStore(":memory:", secret);
  try {
    const drafts = createDrafts(store),
      tasks = createTasks(store);
    const draft = drafts.create({
      ...valid,
      payload: { ...payload, to: "{{Email}}" },
    });
    const review = drafts.review(draft.id, 1);
    assert.equal(review.items[0].payload.html, "<p>A&amp;B</p>");
    assert.equal(review.items[1].payload.to, "two@example.com");
    assert.equal(review.sourceDraftRevision, 1);
    const updated = drafts.update(draft.id, 1, {
      ...drafts.content(draft),
      payload: { ...draft.payload, subject: "Revised {{Name}}" },
    });
    assert.throws(
      () => tasks.confirm(review.id),
      (e) => e instanceof Error && "code" in e && e.code === "stale_review",
    );
    assert.equal(tasks.get(review.id).status, "draft");
    const latest = drafts.review(draft.id, updated.revision);
    assert.equal(tasks.confirm(latest.id).status, "queued");
    assert.equal(tasks.get(review.id).items[0].payload.subject, "Hello A&B");
    const another = drafts.review(draft.id, updated.revision);
    drafts.remove(draft.id, updated.revision);
    assert.throws(() => tasks.confirm(another.id), /review|审核/i);
  } finally {
    store.db.close();
  }
});
test("legacy migration is idempotent and preserves all rendered items for individual editing; history can be copied", () => {
  const store = createStore(":memory:", secret);
  try {
    const tasks = createTasks(store),
      drafts = createDrafts(store);
    const task = tasks.create({
      kind: "email",
      payload: { ...payload, to: "{{Email}}" },
      rows: valid.rows,
    });
    drafts.migrateLegacy();
    drafts.migrateLegacy();
    assert.equal(drafts.list().total, 1);
    const migrated = drafts.get(drafts.list().drafts[0].id);
    assert.equal(migrated.legacyNotice, true);
    assert.deepEqual(
      migrated.legacyItems,
      task.items.map((item: any) => item.payload),
    );
    const values = [...migrated.legacyItems];
    values[1] = { ...values[1], subject: "Edited second item" };
    const edited = drafts.update(migrated.id, 1, {
      ...drafts.content(migrated),
      legacyItems: values,
    });
    assert.throws(() => tasks.confirm(task.id));
    const review = drafts.review(edited.id, 2);
    assert.equal(review.total, 2);
    assert.equal(review.items[1].payload.subject, "Edited second item");
    assert.equal(review.items[0].payload.html, task.items[0].payload.html);
    tasks.confirm(review.id);
    const copied = drafts.fromTask(review.id);
    assert.notEqual(copied.id, edited.id);
    assert.deepEqual(
      copied.legacyItems,
      review.items.map((item: any) => item.payload),
    );
    assert.equal(tasks.get(review.id).status, "queued");
  } finally {
    store.db.close();
  }
});
test("draft APIs require authentication and CSRF, surface conflicts and never execute on save or review", async () => {
  const { app, store } = await buildApp({
    secret,
    setupToken: "draft-tests",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
  });
  store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash("draft-session"),
      JSON.stringify({ authenticated: true, csrfToken: "token" }),
      Date.now() + 60000,
    );
  const headers = {
    cookie: "omnimail=draft-session",
    origin: "http://localhost:5173",
    "x-csrf-token": "token",
  };
  try {
    assert.equal((await app.inject({ url: "/api/drafts" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: "/api/drafts",
          method: "POST",
          headers: { cookie: headers.cookie },
          payload: { content: valid },
        })
      ).statusCode,
      403,
    );
    const result = await app.inject({
      url: "/api/drafts",
      method: "POST",
      headers,
      payload: {
        id: "api-draft",
        content: { kind: "email", payload: { subject: "", html: "", to: "" } },
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(createTasks(store).list().length, 0);
    const updated = await app.inject({
      url: "/api/drafts/api-draft",
      method: "PUT",
      headers,
      payload: {
        expectedRevision: 1,
        content: { ...valid, payload: { ...payload, to: "{{Email}}" } },
      },
    });
    assert.equal(updated.statusCode, 200);
    const stale = await app.inject({
      url: "/api/drafts/api-draft",
      method: "PUT",
      headers,
      payload: { expectedRevision: 1, content: valid },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, "draft_conflict");
    const review = await app.inject({
      url: "/api/drafts/api-draft/review",
      method: "POST",
      headers,
      payload: { expectedRevision: 2 },
    });
    assert.equal(review.statusCode, 200);
    assert.equal(review.json().status, "draft");
    assert.equal(
      createTasks(store)
        .list()
        .filter((task) => task.status === "queued").length,
      0,
    );
  } finally {
    await app.close();
  }
});

test("server-side Agent edits persist immediately and conflicting external edits cannot be overwritten", async () => {
  const { createAgentTools } = await import("./agentTools.js");
  const store = createStore(":memory:", secret);
  try {
    const drafts = createDrafts(store),
      initial = drafts.create(
        {
          kind: "email",
          title: "Agent",
          payload: { to: "", subject: "", html: "" },
        },
        "agent-draft",
      );
    const events: any[] = [];
    const tools = createAgentTools(store, {
      workspace: {
        draftId: initial.id,
        kind: initial.kind,
        payload: initial.payload,
        mapping: {},
        recipientColumn: "",
        revision: initial.revision,
      },
      serverDraft: initial,
      rows: [],
      columns: [],
      attachments: [],
      conversation: [],
      onProgress: (event) => events.push(event),
    });
    tools.execute("update_current_draft", {
      draftId: initial.id,
      expectedRevision: 1,
      patch: { subject: "Persisted by Agent" },
    });
    assert.equal(drafts.get(initial.id).payload.subject, "Persisted by Agent");
    assert.equal(createTasks(store).list().length, 0);
    const current = drafts.get(initial.id);
    drafts.update(current.id, current.revision, {
      ...drafts.content(current),
      payload: { ...current.payload, subject: "Other window" },
    });
    assert.throws(() =>
      tools.execute("update_current_draft", {
        draftId: initial.id,
        expectedRevision: 2,
        patch: { subject: "Lost update" },
      }),
    );
    assert.equal(drafts.get(initial.id).payload.subject, "Other window");
    tools.execute("open_server_draft", { id: initial.id });
    assert(
      events.some(
        (event) => event.type === "open-draft" && event.draftId === initial.id,
      ),
    );
    assert.equal(
      (tools.execute("get_skill", { name: "server-drafts" }) as any).name,
      "server-drafts",
    );
  } finally {
    store.db.close();
  }
});

test("legacy snapshots above the new-draft limit migrate, reopen and update through the API without blocking upgrade", async () => {
  const { app, store } = await buildApp({
    secret,
    setupToken: "legacy-large-test",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
  });
  store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash("large-draft-session"),
      JSON.stringify({ authenticated: true, csrfToken: "token" }),
      Date.now() + 60000,
    );
  const headers = {
    cookie: "omnimail=large-draft-session",
    origin: "http://localhost:5173",
    "x-csrf-token": "token",
  };
  try {
    createTasks(store).create({
      kind: "email",
      payload: {
        to: "{{Email}}",
        subject: "Large legacy batch",
        html: "x".repeat(180000),
      },
      rows: Array.from({ length: 36 }, (_, index) => ({
        Email: `recipient${index}@example.com`,
      })),
    });
    const list = await app.inject({ url: "/api/drafts", headers });
    assert.equal(list.statusCode, 200);
    const draft = createDrafts(store).get(list.json().drafts[0].id);
    assert.equal(draft.legacyItems.length, 36);
    assert(Buffer.byteLength(JSON.stringify(draft)) > 6 * 1024 * 1024);
    const update = await app.inject({
      url: "/api/drafts/" + draft.id,
      method: "PUT",
      headers,
      payload: {
        expectedRevision: 1,
        content: {
          ...createDrafts(store).content(draft),
          title: "Continue editing large legacy batch",
        },
      },
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json().legacyItems.length, 36);
    assert.equal(createDrafts(store).review(draft.id, 2).total, 36);
  } finally {
    await app.close();
  }
});
