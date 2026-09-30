import test from "node:test";
import assert from "node:assert/strict";
import { createAI, providerBaseURL, ProviderError, safeURL } from "./ai.js";
import { createStore, hash } from "./store.js";
import { buildApp } from "./app.js";

const secret = "isolated-provider-tests-at-least-32-characters";
const config = {
  name: "Test provider",
  protocol: "openai-responses" as const,
  baseUrl: "https://provider.invalid/v1",
  apiKey: "fake-secret-key",
  model: "draft-model",
};
const draft = {
  message: "草稿已准备",
  kind: "email" as const,
  payload: { subject: "OmniMail", html: "<p>A safe verification draft.</p>" },
};
const response = (value: unknown, protocol = "openai-responses", extra: Record<string, unknown> = {}) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Response.json(protocol === "anthropic"
    ? { content: [{ type: "tool_use", name: "submit_draft", input: value }], ...extra }
    : protocol === "openai-chat"
      ? { choices: [{ message: { content: text }, finish_reason: "stop" }], ...extra }
      : { output: [{ content: [{ type: "output_text", text }] }], status: "completed", ...extra });
};
const fixture = (fetcher: typeof fetch) => {
  const store = createStore(":memory:", secret);
  return { store, ai: createAI(store, fetcher) };
};
const mock = (handler: (url: string, options: RequestInit) => Response | Promise<Response>) =>
  ((url: any, options: any) => handler(String(url), options)) as typeof fetch;
test("SDK model listing supports every API type with no model field or inference", async () => {
  for (const protocol of ["openai-responses", "openai-chat", "anthropic"] as const) {
    let count = 0;
    const { store, ai } = fixture(mock((url, options) => {
      count++;
      assert.equal(url, "https://provider.invalid/prefix/v1/models");
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      const headers = new Headers(options.headers);
      assert.equal(headers.get(protocol === "anthropic" ? "x-api-key" : "authorization"), "Custom fake-token");
      return Response.json({ data: [{ id: "model", display_name: "Model" }], has_more: false });
    }));
    try {
      const { model, ...withoutModel } = config;
      const result = await ai.discover({ ...withoutModel, protocol, baseUrl: "https://provider.invalid/prefix/v1", headers: { [protocol === "anthropic" ? "X-Api-Key" : "Authorization"]: "Custom fake-token" } });
      assert.deepEqual(result.models, [{ id: "model", name: "Model" }]);
      assert.equal(count, 1);
      assert.deepEqual(ai.list(), []);
    } finally { store.db.close(); }
  }
});

test("SDK listing bounds Anthropic pagination and reports a partial catalog", async () => {
  let count = 0;
  const { store, ai } = fixture(mock(() => {
    count++;
    return Response.json({ data: [{ id: `model-${count}` }], has_more: true, last_id: `model-${count}` });
  }));
  try {
    const result = await ai.discover({ ...config, protocol: "anthropic" });
    assert.equal(count, 10);
    assert.equal(result.models.length, 10);
    assert.equal(result.hasMore, true);
  } finally { store.db.close(); }
});

test("SDK listing does not retry upstream errors or expose raw messages and caps responses", async () => {
  for (const [upstream, expected] of [
    [Response.json({ error: { message: "fake-secret-key upstream echo" } }, { status: 500 }), "provider_http"],
    [Response.json({ error: { message: "fake-secret-key upstream echo" } }, { status: 429 }), "provider_rate_limit"],
    [new Response("x".repeat(2000001)), "response_too_large"],
  ] as const) {
    let count = 0;
    const { store, ai } = fixture(mock(() => { count++; return upstream; }));
    try {
      await assert.rejects(ai.discover(config), (error: unknown) => errorCode(expected)(error) && !String(error).includes("fake-secret-key"));
      assert.equal(count, 1);
    } finally { store.db.close(); }
  }
});

const errorCode = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code;

test("protocol endpoints normalize roots, complete routes and GLM Anthropic prefixes", () => {
  assert.equal(providerBaseURL("https://api.openai.com", "openai-responses"), "https://api.openai.com/v1");
  assert.equal(providerBaseURL("https://provider.invalid/v1/chat/completions/", "openai-chat"), "https://provider.invalid/v1");
  assert.equal(providerBaseURL("https://open.bigmodel.cn/api/anthropic", "anthropic"), "https://open.bigmodel.cn/api/anthropic/v1");
  assert.equal(providerBaseURL("https://open.bigmodel.cn/api/anthropic/v1/messages", "anthropic"), "https://open.bigmodel.cn/api/anthropic/v1");
  assert.equal(providerBaseURL("https://open.bigmodel.cn/api/paas/v4", "openai-chat"), "https://open.bigmodel.cn/api/paas/v4");
  assert.throws(() => providerBaseURL("https://provider.invalid/v1?tenant=demo", "openai-chat"), errorCode("invalid_base_url"));
  assert.equal(safeURL("https://flow.invalid/path?sig=demo"), "https://flow.invalid/path?sig=demo");
});

test("unsaved model discovery requires no model ID and persists no keys or providers", async () => {
  const { store, ai } = fixture(mock((url, options) => {
    assert.equal(url, "https://provider.invalid/v1/models");
    assert.equal(options.method, "GET");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer fake-secret-key");
    return Response.json({ data: [{ id: "model-two" }, { id: "model-one", display_name: "Model One" }] });
  }));
  try {
    const result = await ai.discover({ ...config, model: "" });
    assert.deepEqual(result.models.map(model => model.id), ["model-one", "model-two"]);
    assert.equal(result.models[0].name, "Model One");
    assert.deepEqual(ai.list(), []);
    assert.equal(store.get("defaultProviderId"), null);
  } finally { store.db.close(); }
});

test("Anthropic SDK model discovery follows cursor pagination, deduplicates and ignores malformed entries", async () => {
  let count = 0;
  const { store, ai } = fixture(mock(url => {
    count++;
    return url.includes("after_id=first")
      ? Response.json({ data: [{ id: "first" }, { id: "second" }, null, {}, 42], has_more: false })
      : Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" });
  }));
  try {
    assert.deepEqual((await ai.discover({ ...config, protocol: "anthropic" })).models.map(model => model.id), ["first", "second"]);
    assert.equal(count, 2);
  } finally { store.db.close(); }
});

test("unsupported GLM models endpoint reports failure without document scraping or SDK retries", async () => {
  let count = 0;
  const { store, ai } = fixture(mock((url, options) => {
    count++;
    assert.equal(url, "https://open.bigmodel.cn/api/anthropic/v1/models");
    assert.equal(new Headers(options.headers).get("x-api-key"), "fake-secret-key");
    assert.equal(options.redirect, "error");
    return new Response("unsupported", { status: 404 });
  }));
  try {
    await assert.rejects(ai.discover({ ...config, protocol: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "" }), errorCode("endpoint_unsupported"));
    assert.equal(count, 1);
  } finally { store.db.close(); }
});

test("SDK model discovery never masks credential failures", async () => {
  let count = 0;
  const { store, ai } = fixture(mock(() => {
    count++;
    return new Response("unauthorized", { status: 401 });
  }));
  try {
    await assert.rejects(ai.discover({ ...config, baseUrl: "https://open.bigmodel.cn/api/paas/v4" }), errorCode("provider_auth"));
    assert.equal(count, 1);
  } finally { store.db.close(); }
});

test("model discovery reports partial directories and distinguishes unsupported, empty and unauthorized APIs", async () => {
  for (const [upstream, expected] of [
    [new Response("not found", { status: 404 }), "endpoint_unsupported"],
    [Response.json({ data: [] }), "models_empty"],
    [Response.json({ message: "not a directory" }), "models_empty"],
    [Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }), "provider_auth"],
  ] as const) {
    const { store, ai } = fixture(mock(() => upstream));
    try { await assert.rejects(ai.discover(config), errorCode(expected)); }
    finally { store.db.close(); }
  }
  const { store, ai } = fixture(mock(() => Response.json({ data: [{ id: "one" }], has_more: true, last_id: "one" })));
  try { assert.equal((await ai.discover(config)).hasMore, false); }
  finally { store.db.close(); }
});

test("draft discovery uses unsaved endpoint and header changes while preserving saved secrets", async () => {
  const { store, ai } = fixture(mock((url, options) => {
    assert.equal(url, "https://provider.invalid/other/models");
    assert.equal(new Headers(options.headers).get("x-tenant"), "draft-tenant");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer fake-secret-key");
    return Response.json({ data: [{ id: "draft-model" }] });
  }));
  try {
    const provider = ai.save({ ...config, headers: { "x-tenant": "saved-tenant" } })!;
    await ai.discover({ ...provider, baseUrl: "https://provider.invalid/other", headers: { "x-tenant": "draft-tenant" } });
    assert.equal(ai.list()[0].baseUrl, config.baseUrl);
    assert.equal(JSON.parse(store.decrypt(ai.get(provider.id).headers))["x-tenant"], "saved-tenant");
  } finally { store.db.close(); }
});

test("configuration secrets remain encrypted, preserve omitted headers, and clear explicit empty headers", async () => {
  let latestHeaders = new Headers();
  const { store, ai } = fixture(mock((_url, options) => {
    latestHeaders = new Headers(options.headers);
    return Response.json({ data: [{ id: "draft-model" }] });
  }));
  try {
    const provider = ai.save({ ...config, headers: { "x-tenant": "private-tenant" } })!;
    const listing = ai.list()[0];
    assert.equal(listing.hasHeaders, true);
    assert.ok(!JSON.stringify(listing).includes("fake-secret-key"));
    assert.ok(!JSON.stringify(listing).includes("private-tenant"));
    assert.ok(!JSON.stringify(ai.get(provider.id)).includes("fake-secret-key"));
    ai.save({ ...config, apiKey: "", headers: undefined }, provider.id);
    await ai.models(provider.id);
    assert.equal(latestHeaders.get("x-tenant"), "private-tenant");
    ai.save({ ...config, apiKey: "", headers: {} }, provider.id);
    await ai.models(provider.id);
    assert.equal(latestHeaders.get("x-tenant"), null);
    assert.equal(ai.list()[0].hasHeaders, false);
  } finally { store.db.close(); }
});

test("authentication overrides are case insensitive and never produce comma-joined credentials", async () => {
  for (const name of ["Authorization", "authorization"]) {
    const { store, ai } = fixture(mock((_url, options) => {
      assert.equal(new Headers(options.headers).get("authorization"), "Custom fake-token");
      return Response.json({ data: [{ id: "draft-model" }] });
    }));
    try { await ai.discover({ ...config, headers: { [name]: "Custom fake-token" } }); }
    finally { store.db.close(); }
  }
});

test("credentials cannot be reused for another origin or forwarded to an off-origin model directory", async () => {
  const { store, ai } = fixture(mock(() => { throw Error("Network must not be called"); }));
  try {
    const provider = ai.save(config)!;
    await assert.rejects(ai.discover({ ...provider, baseUrl: "https://other.invalid/v1" }), errorCode("key_required"));
    await assert.rejects(ai.discover({ ...config, headers: { Host: "other.invalid" } }), errorCode("invalid_headers"));
    await assert.rejects(ai.discover({ ...config, headers: { "x-test": "invalid\r\nheader" } }), errorCode("invalid_headers"));
  } finally { store.db.close(); }
});

test("first provider becomes default, explicit selection is atomic, and deletion selects another configured model", () => {
  const { store, ai } = fixture(mock(() => Response.json({})));
  try {
    const first = ai.save(config)!;
    assert.equal(store.get("defaultProviderId"), first.id);
    const second = ai.save({ ...config, name: "Second" })!;
    assert.equal(ai.defaultProviderId(), first.id);
    ai.save({ ...config, makeDefault: true }, second.id);
    assert.equal(ai.defaultProviderId(), second.id);
    ai.remove(second.id);
    assert.equal(ai.defaultProviderId(), first.id);
    ai.remove(first.id);
    assert.equal(ai.defaultProviderId(), "");
  } finally { store.db.close(); }
});

test("legacy single provider without a default remains usable without modifying stored configuration", () => {
  const { store, ai } = fixture(mock(() => Response.json({})));
  try {
    const provider = ai.save({ ...config, protocol: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic" })!;
    store.set("defaultProviderId", "");
    assert.equal(ai.defaultProviderId(), provider.id);
    assert.equal(store.get("defaultProviderId"), "");
    assert.equal(ai.list()[0].baseUrl, "https://open.bigmodel.cn/api/anthropic/v1");
  } finally { store.db.close(); }
});

test("all three API types verify actual structured drafting using the unsaved configuration", async () => {
  for (const protocol of ["openai-responses", "openai-chat", "anthropic"] as const) {
    const { store, ai } = fixture(mock((url, options) => {
      const body = JSON.parse(String(options.body));
      assert.equal(body.model, "unsaved-model");
      assert.equal(options.method, "POST");
      if (protocol === "anthropic") {
        assert.ok(url.endsWith("/v1/messages"));
        assert.equal(body.tool_choice.name, "submit_draft");
        assert.equal(new Headers(options.headers).get("x-api-key"), "fake-secret-key");
        assert.equal(body.max_tokens, 1024);
      } else if (protocol === "openai-chat") {
        assert.ok(url.endsWith("/chat/completions"));
        assert.equal(body.response_format.type, "json_object");
        assert.equal(body.max_tokens, 1024);
      } else {
        assert.ok(url.endsWith("/responses"));
        assert.equal(body.text.format.type, "json_object");
        assert.equal(body.store, false);
        assert.equal(body.max_output_tokens, 1024);
      }
      return response(draft, protocol);
    }));
    try {
      const result = await ai.verify({ ...config, protocol, model: "unsaved-model" });
      assert.equal(result.ok, true);
      assert.equal(result.capability, "drafting");
      assert.equal(result.model, "unsaved-model");
      assert.deepEqual(ai.list(), []);
      assert.equal((store.db.prepare("SELECT count(*) AS count FROM tasks").get() as any).count, 0);
    } finally { store.db.close(); }
  }
});

test("official OpenAI requests enforce strict JSON schema while prompt fallback is explicit", async () => {
  for (const outputMode of ["auto", "prompt"] as const) {
    const { store, ai } = fixture(mock((_url, options) => {
      const body = JSON.parse(String(options.body));
      if (outputMode === "auto") {
        assert.equal(body.text.format.type, "json_schema");
        assert.equal(body.text.format.strict, true);
        assert.equal(body.text.format.schema.additionalProperties, false);
      } else assert.equal(body.text, undefined);
      return response(draft);
    }));
    try { await ai.verify({ ...config, baseUrl: "https://api.openai.com/v1", outputMode }); }
    finally { store.db.close(); }
  }
});

test("a plain OK response, an empty draft and invented recipients fail drafting verification", async () => {
  for (const [value, expected] of [
    ["OK", "output_invalid"],
    [{ ...draft, payload: {} }, "draft_check_failed"],
    [{ ...draft, payload: { ...draft.payload, to: "invented@example.invalid" } }, "draft_check_failed"],
  ] as const) {
    const { store, ai } = fixture(mock(() => response(value)));
    try { await assert.rejects(ai.verify(config), errorCode(expected)); }
    finally { store.db.close(); }
  }
});

test("incomplete, refused and truncated outputs fail instead of showing green verification", async () => {
  const upstreams = [
    response(draft, "openai-responses", { status: "incomplete" }),
    response(draft, "anthropic", { stop_reason: "max_tokens" }),
    response(draft, "openai-chat", { choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "length" }] }),
    Response.json({ output: [{ content: [{ type: "refusal", refusal: "No" }] }] }),
  ];
  for (const [index, upstream] of upstreams.entries()) {
    const { store, ai } = fixture(mock(() => upstream));
    try { await assert.rejects(ai.verify({ ...config, protocol: index === 1 ? "anthropic" : index === 2 ? "openai-chat" : "openai-responses" }), errorCode(index === 3 ? "output_refused" : "output_incomplete")); }
    finally { store.db.close(); }
  }
});

test("subject-only agent changes preserve recipients and body while unsupported fields are rejected", async () => {
  let payload: Record<string, string> = { subject: "New subject" };
  const { store, ai } = fixture(mock(() => response({ ...draft, payload })));
  try {
    ai.save(config);
    const original = { to: "recipient@example.invalid", cc: "", bcc: "", subject: "Original subject", html: "<p>Original body</p>" };
    const request = { message: "Change only the subject", kind: "email", payload: original };
    const result = await ai.agent(request);
    assert.deepEqual(result.payload, { ...original, subject: "New subject" });
    payload = { attachment: "unsupported" };
    await assert.rejects(ai.agent(request), errorCode("output_invalid"));
    assert.equal(original.subject, "Original subject");
  } finally { store.db.close(); }
});

test("strict-schema null fields are discarded and array mapping is normalized", async () => {
  const { store, ai } = fixture(mock(() => response({ ...draft, payload: { ...draft.payload, to: null, start: null }, templateId: null, mapping: [{ field: "name", column: "姓名" }] })));
  try {
    ai.save(config);
    const result = await ai.agent({ message: "Use the batch names", kind: "email", payload: { to: "recipient@example.invalid" }, columns: ["姓名"] });
    assert.equal(result.payload.to, "recipient@example.invalid");
    assert.equal(result.payload.start, undefined);
    assert.deepEqual(result.mapping, { name: "姓名" });
  } finally { store.db.close(); }
});

test("provider diagnostics retain safe error codes without echoing upstream credentials", async () => {
  const { store, ai } = fixture(mock(() => Response.json({ error: { code: "unsupported_parameter", message: "fake-secret-key upstream secret echo" } }, { status: 400 })));
  try {
    await assert.rejects(ai.verify(config), (error: any) => {
      assert.equal(error.code, "provider_http");
      assert.ok(error.message.includes("unsupported_parameter"));
      assert.ok(!error.message.includes("fake-secret-key"));
      return true;
    });
  } finally { store.db.close(); }
});

test("large and malformed upstream responses fail before processing drafts", async () => {
  for (const [upstream, expected] of [
    [new Response("x".repeat(2000001)), "response_too_large"],
    [new Response("not json"), "invalid_response"],
  ] as const) {
    const { store, ai } = fixture(mock(() => upstream));
    try { await assert.rejects(ai.verify(config), errorCode(expected)); }
    finally { store.db.close(); }
  }
});

test("draft discover/verify API is authenticated, does not require saved configuration and creates no tasks", async () => {
  const fixture = await buildApp({ secret, setupToken: "fake-token", origin: "http://localhost:5173", dbPath: ":memory:", worker: false, staticRoot: "/nonexistent", fetcher: mock(url => url.endsWith("/models") ? Response.json({ data: [{ id: "draft-model" }] }) : response(draft)) });
  const sessionId = "provider-test-session";
  fixture.store.db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(hash(sessionId), JSON.stringify({ authenticated: true, csrfToken: "test-csrf" }), Date.now() + 60000);
  const headers = { cookie: `omnimail=${sessionId}`, "x-csrf-token": "test-csrf", origin: "http://localhost:5173" };
  try {
    assert.equal((await fixture.app.inject({ method: "POST", url: "/api/providers/discover", payload: config })).statusCode, 401);
    assert.equal((await fixture.app.inject({ method: "POST", url: "/api/providers/discover", headers: { cookie: headers.cookie }, payload: config })).statusCode, 403);
    assert.equal((await fixture.app.inject({ method: "POST", url: "/api/providers/discover", headers, payload: { ...config, model: "" } })).statusCode, 200);
    const verify = await fixture.app.inject({ method: "POST", url: "/api/providers/verify", headers, payload: config });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().capability, "drafting");
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM providers").get() as any).count, 0);
    assert.equal((fixture.store.db.prepare("SELECT count(*) AS count FROM tasks").get() as any).count, 0);
  } finally { await fixture.app.close(); }
});
