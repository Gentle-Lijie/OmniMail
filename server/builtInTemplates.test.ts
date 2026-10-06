import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtInTemplates,
  initializeBuiltInTemplates,
} from "./builtInTemplates.js";
import { createStore, hash } from "./store.js";
import { createTemplates, templateSchema } from "./templates.js";
import { createTasks, webhookBody } from "./tasks.js";
import { fieldsIn } from "./draftValidation.js";
import { buildApp } from "./app.js";

const secret = "builtin-template-test-secret-at-least-32-characters";

test("imported templates contain a ready-to-edit CPU layout and OmniMail signature without renderer tokens", () => {
  assert.equal(builtInTemplates.length, 1);
  for (const template of builtInTemplates) {
    assert.deepEqual(templateSchema.parse(template), template);
    assert.equal(template.kind, "email");
    assert.match(template.html, /<!doctype html>/i);
    assert.match(template.html, /prefers-color-scheme: dark/);
    assert.match(template.html, /max-width: 480px/);
    assert.match(template.html, /role="presentation"/);
    assert.match(template.html, /max-width: 600px/);
    assert.match(
      template.html,
      /data-omnimail-signature="true">Sent with OmniMail/,
    );
    assert.deepEqual(
      fieldsIn({ subject: template.subject, html: template.html }),
      [],
    );
    assert.deepEqual(template.fields, []);
    assert.doesNotMatch(template.html, /<script\b|https?:\/\//i);
  }
});

test("initialization creates ordinary versioned templates once without replacing existing templates", () => {
  const store = createStore(":memory:", secret);
  const templates = createTemplates(store);
  try {
    const existing = templates.create({
      name: "User template",
      kind: "email",
      subject: "Keep",
      html: "<p>User content</p>",
    });
    const imported = initializeBuiltInTemplates(store);
    assert.equal(imported.length, builtInTemplates.length);
    assert.equal(templates.list().length, imported.length + 1);
    assert.deepEqual(templates.get(existing.id), existing);
    for (const template of imported) {
      assert.equal(template.version, 1);
      assert.deepEqual(templates.versions(template.id), [template]);
    }
    assert.deepEqual(initializeBuiltInTemplates(store), []);
    const updated = templates.update(
      imported[0].id,
      { subject: "Customized" },
      1,
    );
    initializeBuiltInTemplates(store);
    assert.deepEqual(templates.get(updated.id), updated);
    const restored = templates.rollback(updated.id, 1, 2);
    assert.equal(restored.subject, builtInTemplates[0].subject);
    templates.remove(restored.id);
    assert.deepEqual(initializeBuiltInTemplates(store), []);
    assert.deepEqual(templates.list(), [existing]);
  } finally {
    store.db.close();
  }
});

test("initialization marker survives database reopen and respects deleted built-ins", () => {
  const directory = mkdtempSync(join(tmpdir(), "omnimail-builtins-"));
  const path = join(directory, "mail.sqlite");
  const first = createStore(path, secret);
  try {
    const imported = initializeBuiltInTemplates(first);
    createTemplates(first).remove(imported[0].id);
  } finally {
    first.db.close();
  }
  const reopened = createStore(path, secret);
  try {
    assert.deepEqual(initializeBuiltInTemplates(reopened), []);
    assert.deepEqual(createTemplates(reopened).list(), []);
  } finally {
    reopened.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed initialization rolls back templates, versions and completion marker and can retry", () => {
  const store = createStore(":memory:", secret);
  try {
    store.db.exec(
      "CREATE TRIGGER reject_builtin_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test initialization failure'); END",
    );
    assert.throws(
      () => initializeBuiltInTemplates(store),
      /test initialization failure/,
    );
    assert.deepEqual(createTemplates(store).list(), []);
    assert.equal(
      (
        store.db
          .prepare("SELECT count(*) AS count FROM template_versions")
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(store.get("builtInTemplates.cpuStyle.v1"), null);
    store.db.exec("DROP TRIGGER reject_builtin_audit");
    assert.equal(
      initializeBuiltInTemplates(store).length,
      builtInTemplates.length,
    );
  } finally {
    store.db.close();
  }
});

test("built-in signature is part of the editable task body and webhook payload, not forced on unrelated email", () => {
  const store = createStore(":memory:", secret);
  try {
    const [template] = initializeBuiltInTemplates(store);
    const tasks = createTasks(store);
    const task = tasks.create({
      kind: "email",
      templateId: template.id,
      payload: {
        to: "recipient@example.com",
        subject: template.subject,
        html: template.html,
      },
    });
    assert.equal(task.status, "draft");
    assert.equal(task.template.version, 1);
    assert.equal(task.items[0].payload.html, template.html);
    const body = webhookBody("email", task.items[0].payload);
    assert.equal(
      (body.attachments[0].content as { email: { html: string } }).email.html,
      template.html,
    );
    assert.equal(
      (
        webhookBody("email", { html: "<p>Existing body</p>" }).attachments[0]
          .content as { email: { html: string } }
      ).email.html,
      "<p>Existing body</p>",
    );
  } finally {
    store.db.close();
  }
});

test("application startup exposes built-in templates through the authenticated template API", async () => {
  const { app, store } = await buildApp({
    secret,
    setupToken: "test-setup",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
    staticRoot: "/nonexistent",
  });
  store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash("builtin-session"),
      JSON.stringify({ authenticated: true, csrfToken: "csrf" }),
      Date.now() + 60000,
    );
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/templates" })).statusCode,
      401,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/templates",
      headers: { cookie: "omnimail=builtin-session" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().length, builtInTemplates.length);
    assert.equal(response.json()[0].name, builtInTemplates[0].name);
    assert.match(response.json()[0].html, /Sent with OmniMail/);
    assert.equal(createTasks(store).list().length, 0);
  } finally {
    await app.close();
  }
});
