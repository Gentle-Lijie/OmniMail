import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { createStore, hash } from "./store.js";
import {
  createTasks,
  validatePayload,
  renderPayload,
  webhookBody,
} from "./tasks.js";
import { createAI } from "./ai.js";
const secret = "test-secret-that-is-at-least-32-characters";
const mail = {
  to: "scylz12@nottingham.edu.cn",
  cc: "",
  bcc: "zljzljsweepy@qq.com",
  subject: "Test",
  html: "<p>Hello</p>",
};
const event = {
  subject: "Test",
  start: "2026-09-30T10:00:00",
  end: "2026-09-30T11:00:00",
  requiredAttendees: mail.to,
  optionalAttendees: mail.bcc,
  location: "",
  html: "",
};
const mock = (fn: Function) =>
  (async (...args: any[]) => fn(...args)) as typeof fetch;
test("payload schemas enforce addresses, real dates, Beijing timezone and field whitelist", () => {
  assert.equal((validatePayload("email", mail) as any).bcc, mail.bcc);
  assert.throws(() => validatePayload("email", { ...mail, to: "invalid" }));
  assert.throws(() => validatePayload("email", { ...mail, attachment: "x" }));
  assert.throws(() =>
    validatePayload("event", { ...event, start: "2026-02-30T10:00:00" }),
  );
  assert.throws(() =>
    validatePayload("event", { ...event, start: event.end, end: event.start }),
  );
  assert.throws(() =>
    validatePayload("event", { ...event, start: event.start + "Z" }),
  );
  assert.equal(
    (webhookBody("email", mail).attachments[0].content as any).email.to,
    mail.to,
  );
});
test("batch rendering escapes HTML values and rejects missing fields", () => {
  assert.equal(
    renderPayload(
      { html: "Hello {{name}}", to: "{{receiver}}" },
      { name: "<script>", receiver: mail.to },
    ).html,
    "Hello &lt;script&gt;",
  );
  assert.throws(() => renderPayload({ subject: "{{missing}}" }, {}));
});
test("secrets encrypted and authenticated", () => {
  const s = createStore(":memory:", secret);
  const cipher = s.encrypt("sensitive");
  assert.ok(!cipher.includes("sensitive"));
  assert.equal(s.decrypt(cipher), "sensitive");
  assert.throws(() => s.decrypt(cipher.slice(0, -3) + "aaa"));
  s.db.close();
});
test("draft cannot execute, confirmation is one-shot, acceptance is not delivery", async () => {
  const s = createStore(":memory:", secret);
  s.set("rateLimitMs", 0);
  s.set("mailWebhookUrl", s.encrypt("https://mock.invalid"));
  let n = 0;
  const t = createTasks(
    s,
    mock((_url: any, opts: any) => {
      n++;
      assert.equal(
        JSON.parse(opts.body).attachments[0].content.email.to,
        mail.to,
      );
      return new Response("", { status: 202 });
    }),
  );
  const task = t.create({ kind: "email", payload: mail });
  await t.run();
  assert.equal(n, 0);
  t.confirm(task.id);
  assert.throws(() => t.confirm(task.id));
  await t.run();
  await t.run();
  assert.equal(n, 1);
  assert.equal(t.get(task.id).status, "accepted");
  s.db.close();
});
test("uncertain timeouts are never automatically retried", async () => {
  const s = createStore(":memory:", secret);
  s.set("rateLimitMs", 0);
  s.set("eventWebhookUrl", s.encrypt("https://mock.invalid"));
  let n = 0;
  const t = createTasks(
    s,
    mock(() => {
      n++;
      throw new Error("timeout https://secret.invalid");
    }),
  );
  const task = t.create({ kind: "event", payload: event });
  t.confirm(task.id);
  await t.run();
  await t.run();
  assert.equal(n, 1);
  assert.equal(t.get(task.id).status, "uncertain");
  assert.ok(!JSON.stringify(t.get(task.id)).includes("secret.invalid"));
  s.db.close();
});
test("cancelling in-flight batch keeps pending items cancelled", async () => {
  const s = createStore(":memory:", secret);
  s.set("rateLimitMs", 0);
  s.set("mailWebhookUrl", s.encrypt("https://mock.invalid"));
  let release: Function = () => {};
  const t = createTasks(
    s,
    mock(
      () =>
        new Promise(
          (r) => (release = () => r(new Response("", { status: 202 }))),
        ),
    ),
  );
  const task = t.create({ kind: "email", payload: mail, rows: [{}, {}] });
  t.confirm(task.id);
  const running = t.run();
  await new Promise((r) => setTimeout(r, 5));
  t.cancel(task.id);
  release();
  await running;
  assert.equal(t.get(task.id).status, "cancelled");
  assert.equal(t.get(task.id).items[1].status, "cancelled");
  s.db.close();
});
test("restart marks in-flight request uncertain without retrying it", () => {
  const s = createStore(":memory:", secret);
  const t = createTasks(s);
  const task = t.create({ kind: "email", payload: mail });
  task.status = "running";
  task.items[0].status = "running";
  s.db
    .prepare("UPDATE tasks SET value=? WHERE id=?")
    .run(JSON.stringify(task), task.id);
  t.start();
  t.stop();
  assert.equal(t.get(task.id).status, "uncertain");
  s.db.close();
});
test("both AI protocols, model listing and secret-free settings", async () => {
  const s = createStore(":memory:", secret);
  let called: any;
  const a = createAI(
    s,
    mock((url: any, options: any) => {
      called = { url, options };
      return new Response(
        JSON.stringify(
          url.endsWith("/models")
            ? { data: [{ id: "model" }] }
            : url.endsWith("/responses")
              ? { output: [{ content: [{ type: "output_text", text: "OK" }] }] }
              : { content: [{ type: "text", text: "OK" }] },
        ),
      );
    }),
  );
  for (const protocol of ["openai-responses", "anthropic"]) {
    const p = a.save({
      name: protocol,
      protocol,
      baseUrl: "https://mock.invalid/v1",
      apiKey: "private-key",
      model: "model",
    });
    assert.equal((await a.models(p.id)).models[0].id, "model");
    assert.equal((await a.test(p.id)).text, "OK");
    assert.ok(
      called.url.endsWith(
        protocol === "anthropic" ? "/messages" : "/responses",
      ),
    );
    assert.ok(!JSON.stringify(a.list()).includes("private-key"));
  }
  s.db.close();
});
async function fixture() {
  const f = await buildApp({
    secret,
    setupToken: "test-setup",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
    staticRoot: "/nonexistent",
    fetcher: mock(() => new Response("", { status: 202 })),
  });
  const sid = "test-session";
  f.store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash(sid),
      JSON.stringify({ authenticated: true, csrfToken: "csrf" }),
      Date.now() + 60000,
    );
  const headers = { cookie: `omnimail=${sid}`, "x-csrf-token": "csrf" };
  return { ...f, headers };
}
test("API authentication, CSRF, origin and first setup are enforced", async () => {
  const { app, headers } = await fixture();
  try {
    assert.equal((await app.inject("/api/settings")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers: { cookie: headers.cookie },
          payload: { language: "en" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/settings",
          headers: { ...headers, origin: "https://evil.invalid" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/register/options",
          payload: { setupToken: "wrong" },
        })
      ).statusCode,
      403,
    );
    const res = await app.inject("/api/auth/status");
    assert.equal(res.json().needsSetup, true);
    assert.ok(res.json().csrfToken);
  } finally {
    await app.close();
  }
});
test("templates version and rollback, settings secret masking, tasks snapshot", async () => {
  const { app, headers } = await fixture();
  try {
    const request = (method: any, url: string, payload?: any) =>
      app.inject({ method, url, headers, payload });
    const first = (
      await request("POST", "/api/templates", {
        name: "Welcome",
        kind: "email",
        subject: "Original",
        html: "<p>Hello</p>",
      })
    ).json();
    assert.ok(first.id);
    await request("PUT", `/api/templates/${first.id}`, {
      ...first,
      subject: "Edited",
    });
    const rolled = (
      await request("POST", `/api/templates/${first.id}/rollback`, {
        version: 1,
      })
    ).json();
    assert.equal(rolled.version, 3);
    assert.equal(rolled.subject, "Original");
    assert.equal(
      (await request("GET", `/api/templates/${first.id}/versions`)).json()
        .length,
      3,
    );
    const task = (
      await request("POST", "/api/tasks", {
        kind: "email",
        payload: mail,
        templateId: first.id,
      })
    ).json();
    assert.equal(task.template.version, 3);
    assert.equal(task.status, "draft");
    await request("PUT", "/api/settings", {
      mailWebhookUrl: "https://mock.invalid/?sig=secret",
    });
    assert.ok(
      !JSON.stringify((await request("GET", "/api/settings")).json()).includes(
        "sig=",
      ),
    );
  } finally {
    await app.close();
  }
});
test("CSV import and MCP key revocation/direct execution protocol", async () => {
  const { app, headers, tasks } = await fixture();
  try {
    const data =
      '--BOUND\r\nContent-Disposition: form-data; name="file"; filename="test.csv"\r\nContent-Type: text/csv\r\n\r\nname,receiver\nTest,scylz12@nottingham.edu.cn\r\n--BOUND--\r\n';
    const imported = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: {
        ...headers,
        "content-type": "multipart/form-data; boundary=BOUND",
      },
      payload: data,
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().count, 1);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/mcp/keys",
        headers,
        payload: { name: "Test" },
      })
    ).json();
    const mh = {
      authorization: `Bearer ${created.key}`,
      accept: "application/json, text/event-stream",
    };
    assert.equal(
      (await app.inject({ method: "POST", url: "/mcp", payload: {} }))
        .statusCode,
      401,
    );
    const init = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mh,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
    });
    assert.equal(init.statusCode, 200);
    assert.ok(init.json().result.serverInfo);
    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: mh,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send_email", arguments: { payload: mail } },
      },
    });
    assert.equal(call.statusCode, 200);
    const result = JSON.parse(call.json().result.content[0].text);
    assert.equal(result.status, "queued");
    assert.ok(tasks.get(result.id).source.startsWith("mcp:"));
    const batchCall = async (receiver: string) =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: mh,
        payload: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "send_email",
            arguments: {
              payload: { ...mail, to: "{{receiver}}" },
              rows: [{ receiver }],
            },
          },
        },
      });
    const batch = await batchCall(mail.to);
    const batchResult = JSON.parse(batch.json().result.content[0].text);
    assert.equal(batchResult.status, "queued");
    assert.equal(tasks.get(batchResult.id).items[0].payload.to, mail.to);
    const before = tasks.list().length;
    const invalid = await batchCall("not-an-address");
    assert.equal(invalid.json().result.isError, true);
    assert.equal(tasks.list().length, before);
    await app.inject({
      method: "DELETE",
      url: `/api/mcp/keys/${created.id}`,
      headers,
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: mh,
          payload: {},
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("cancelled in-flight task recovers uncertain item without resuming", async () => {
  const s = createStore(":memory:", secret);
  const t = createTasks(s);
  const task = t.create({ kind: "email", payload: mail, rows: [{}, {}] });
  task.status = "cancelled";
  task.items[0].status = "running";
  task.items[1].status = "cancelled";
  s.db
    .prepare("UPDATE tasks SET value=? WHERE id=?")
    .run(JSON.stringify(task), task.id);
  t.start();
  await t.stop();
  assert.equal(t.get(task.id).status, "cancelled");
  assert.equal(t.get(task.id).items[0].status, "uncertain");
  assert.equal(t.get(task.id).items[1].status, "cancelled");
  s.db.close();
});
