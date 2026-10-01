import { serverMessage, withLocale, requestLocale } from "./i18n.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { z } from "zod";
import { createStore, id, hash } from "./store.js";
import { configureAuth } from "./auth.js";
import { createTasks, eventSchema } from "./tasks.js";
import { createAI, safeURL, ProviderError } from "./ai.js";
import { readAgentAttachment } from "./agentAttachments.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
export interface AppOptions {
  secret: string;
  setupToken: string;
  origin: string;
  dbPath?: string;
  fetcher?: typeof fetch;
  worker?: boolean;
  staticRoot?: string;
}
export async function buildApp(options: AppOptions) {
  const store = createStore(
    options.dbPath ?? "data/omnimail.sqlite",
    options.secret,
  );
  const { db } = store;
  const tasks = createTasks(store, options.fetcher);
  const ai = createAI(store, options.fetcher);
  const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
  });
  app.addHook("onRequest", (req, _reply, done) => {
    withLocale(requestLocale(req.headers["accept-language"]), done);
  });
  configureAuth(app, store, options.origin, options.setupToken);
  app.setErrorHandler((err, req, reply) => {
    const e = err as any;
    let message =
      e instanceof z.ZodError
        ? e.issues
            .map((i: any) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
        : e.message || serverMessage("app.requestFailed");
    if (
      message.includes("SQLITE") ||
      message.includes("constraint") ||
      message.includes("fetch") ||
      message.includes("https://")
    )
      message = serverMessage("app.requestFailedCheckConfigurationOrInput");
    reply.code(e.statusCode && e.statusCode >= 400 ? e.statusCode : 400).send({
      error: message,
      ...(e instanceof ProviderError
        ? { code: e.code, upstreamStatus: e.upstreamStatus }
        : {}),
    });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/dashboard", async () => {
    const all = tasks.list();
    return {
      tasks: (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n,
      accepted: all.reduce((s, t) => s + t.accepted, 0),
      failed: all.reduce((s, t) => s + t.failed, 0),
      templates: (
        db.prepare("SELECT COUNT(*) AS n FROM templates").get() as any
      ).n,
    };
  });
  const settings = () => ({
    registrationEnabled: store.get("registrationEnabled", true),
    language: store.get("language", "zh"),
    rateLimitMs: store.get("rateLimitMs", 1000),
    prompt: store.get("prompt", ""),
    defaultProviderId: ai.defaultProviderId(),
    providers: ai.list(),
    mailConfigured: !!store.get("mailWebhookUrl"),
    eventConfigured: !!store.get("eventWebhookUrl"),
  });
  app.get("/api/settings", async () => settings());
  app.put("/api/settings", async (req) => {
    const body = z
      .object({
        registrationEnabled: z.boolean().optional(),
        language: z.enum(["zh", "en", "zh-CN"]).optional(),
        rateLimitMs: z.number().int().min(100).max(60000).optional(),
        prompt: z.string().max(20000).optional(),
        defaultProviderId: z.string().optional(),
        mailWebhookUrl: z.string().optional(),
        eventWebhookUrl: z.string().optional(),
      })
      .parse(req.body);
    if (body.defaultProviderId) ai.get(body.defaultProviderId);
    for (const [key, value] of Object.entries(body)) {
      if (key.endsWith("WebhookUrl")) {
        if (value === "") store.set(key, null);
        else store.set(key, store.encrypt(safeURL(String(value))));
      } else store.set(key, value);
    }
    store.audit("settings.updated");
    return settings();
  });
  app.post("/api/providers", async (req) => ai.save(req.body));
  app.post("/api/providers/discover", async (req) => ai.discover(req.body));
  app.post("/api/providers/verify", async (req) => ai.verify(req.body));
  app.put<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    ai.get(req.params.id);
    return ai.save(req.body, req.params.id);
  });
  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    ai.remove(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    "/api/providers/:id/models",
    async (req) => ai.models(req.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (req) =>
    ai.test(req.params.id, (req.body as any)?.model),
  );
  app.post("/api/agent/attachments", async (req) => {
    const file = await req.file();
    if (!file) throw Error(serverMessage("app.fileRequired"));
    return readAgentAttachment(file.filename, await file.toBuffer());
  });
  app.post("/api/agent", async (req, reply) => {
    if (!req.headers.accept?.includes("text/event-stream"))
      return ai.agent(req.body);
    const stream = new PassThrough();
    const controller = new AbortController();
    let lastStage = "";
    const emit = (event: Record<string, unknown>) => {
      if (stream.destroyed || controller.signal.aborted) return;
      if (event.type === "progress") {
        if (event.stage === lastStage) return;
        lastStage = String(event.stage);
      }
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!stream.destroyed) stream.write(": heartbeat\n\n");
    }, 10000);
    reply.raw.on("close", () => {
      controller.abort();
      clearInterval(heartbeat);
      stream.destroy();
    });
    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("X-Accel-Buffering", "no");
    void ai
      .agent(req.body, {
        onProgress: (event) => emit({ ...event }),
        signal: controller.signal,
      })
      .then((result) => emit({ type: "result", result }))
      .catch((error) => {
        const message =
          error instanceof ProviderError
            ? error.message
            : error instanceof z.ZodError
              ? serverMessage("app.invalidAgentRequestOrAttachments")
              : serverMessage(
                  "app.agentRequestFailedCheckInputAndConfiguration",
                );
        emit({
          type: "error",
          error: message,
          ...(error instanceof ProviderError ? { code: error.code } : {}),
        });
      })
      .finally(() => {
        clearInterval(heartbeat);
        stream.end();
      });
    return reply.send(stream);
  });
  const templateSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    kind: z.enum(["email", "event"]),
    subject: z.string().max(998).default(""),
    html: z.string().max(500000).default(""),
    fields: z
      .array(z.string().regex(/^[\w.-]+$/))
      .max(100)
      .default([]),
  });
  const templates = () =>
    (db.prepare("SELECT value FROM templates").all() as any[]).map((r) =>
      JSON.parse(r.value),
    );
  const templateGet = (templateId: string) => {
    const r = db
      .prepare("SELECT value FROM templates WHERE id=?")
      .get(templateId) as any;
    if (!r) throw new Error(serverMessage("app.templateNotFound"));
    return JSON.parse(r.value);
  };
  const templateSave = (body: any, templateId = id(), version = 1) => {
    const value = {
      ...templateSchema.parse(body),
      id: templateId,
      version,
      createdAt: new Date().toISOString(),
    };
    db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO templates VALUES (?,?)").run(
        templateId,
        JSON.stringify(value),
      );
      db.prepare("INSERT INTO template_versions VALUES (?,?,?)").run(
        templateId,
        version,
        JSON.stringify(value),
      );
    })();
    store.audit("template.saved");
    return value;
  };
  app.get("/api/templates", async () => templates());
  app.post("/api/templates", async (req) => templateSave(req.body));
  app.put<{ Params: { id: string } }>("/api/templates/:id", async (req) =>
    templateSave(
      req.body,
      req.params.id,
      templateGet(req.params.id).version + 1,
    ),
  );
  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    db.prepare("DELETE FROM templates WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>(
    "/api/templates/:id/versions",
    async (req) =>
      (
        db
          .prepare(
            "SELECT value FROM template_versions WHERE templateId=? ORDER BY version DESC",
          )
          .all(req.params.id) as any[]
      ).map((r) => JSON.parse(r.value)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/templates/:id/rollback",
    async (req) => {
      const version = z
        .object({ version: z.number().int().positive() })
        .parse(req.body).version;
      const row = db
        .prepare(
          "SELECT value FROM template_versions WHERE templateId=? AND version=?",
        )
        .get(req.params.id, version) as any;
      if (!row) throw new Error(serverMessage("app.versionNotFound"));
      return templateSave(
        JSON.parse(row.value),
        req.params.id,
        templateGet(req.params.id).version + 1,
      );
    },
  );
  app.post("/api/import", async (req) => {
    const file = await req.file();
    if (!file) throw new Error(serverMessage("app.fileRequired"));
    const buffer = await file.toBuffer();
    let rows: any[];
    const check = (columns: any[]) => {
      if (
        !columns.length ||
        columns.length > 100 ||
        columns.some(
          (c) =>
            typeof c !== "string" ||
            !c.trim() ||
            ["__proto__", "constructor", "prototype"].includes(c),
        ) ||
        new Set(columns).size !== columns.length
      )
        throw new Error(serverMessage("app.invalidOrDuplicateColumnHeaders"));
      return columns;
    };
    if (/\.csv$/i.test(file.filename))
      rows = parse(buffer, {
        columns: (columns: string[]) => check(columns),
        bom: true,
        skip_empty_lines: true,
        trim: true,
        max_record_size: 50000,
      });
    else if (/\.xlsx?$/i.test(file.filename)) {
      const workbook = XLSX.read(buffer, {
        type: "buffer",
        sheetRows: 1002,
        cellDates: false,
      });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<any[]>(sheet, {
        header: 1,
        defval: "",
        raw: false,
      });
      check(raw[0] ?? []);
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    } else throw new Error(serverMessage("app.useCSVXLSOrXLSX"));
    if (!rows.length || rows.length > 1000)
      throw new Error(serverMessage("app.importMustContain11000DataRows"));
    const columns = check(Object.keys(rows[0]));
    return { columns, rows, count: rows.length };
  });
  app.get("/api/tasks", async () =>
    tasks.list().map(({ items, payload, conversation, template, ...task }) => ({
      ...task,
      templateId: template?.id,
    })),
  );
  app.post("/api/tasks", async (req) => tasks.create(req.body));
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) =>
    tasks.get(req.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/tasks/:id/confirm", async (req) =>
    tasks.confirm(req.params.id),
  );
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req) =>
    tasks.cancel(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/events",
    async (req, reply) => {
      tasks.get(req.params.id);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      const send = () => {
        if (closed) return;
        try {
          reply.raw.write(
            `data: ${JSON.stringify(tasks.get(req.params.id))}\n\n`,
          );
        } catch {
          reply.raw.end();
        }
      };
      send();
      const timer = setInterval(send, 1000);
      req.raw.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
    },
  );
  app.get("/api/mcp/keys", async () =>
    db.prepare("SELECT id,name,prefix,createdAt FROM mcp_keys").all(),
  );
  app.post("/api/mcp/keys", async (req) => {
    const name = z
      .object({ name: z.string().min(1).max(100) })
      .parse(req.body).name;
    const key = `omni_${id()}${id()}`;
    const keyId = id();
    db.prepare("INSERT INTO mcp_keys VALUES (?,?,?,?,?)").run(
      keyId,
      name,
      key.slice(0, 13),
      hash(key),
      new Date().toISOString(),
    );
    store.audit("mcp.key.created");
    return { id: keyId, key };
  });
  app.delete<{ Params: { id: string } }>("/api/mcp/keys/:id", async (req) => {
    db.prepare("DELETE FROM mcp_keys WHERE id=?").run(req.params.id);
    store.audit("mcp.key.revoked");
    return { ok: true };
  });
  app.post("/mcp", async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== options.origin)
      return reply
        .code(403)
        .send({ error: serverMessage("app.originNotAllowed") });
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const key = token
      ? (db
          .prepare("SELECT id FROM mcp_keys WHERE hash=?")
          .get(hash(token)) as any)
      : null;
    if (!key)
      return reply
        .code(401)
        .send({ error: serverMessage("app.validBearerAPIKeyRequired") });
    const server = new McpServer({ name: "OmniMail", version: "1.0.0" });
    const result = (data: any) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    });
    server.tool(
      "send_email",
      serverMessage("mcp.sendEmail"),
      {
        payload: z
          .object({
            to: z.string().min(1).max(10000),
            cc: z.string().max(10000).default(""),
            bcc: z.string().max(10000).default(""),
            subject: z.string().min(1).max(998),
            html: z.string().min(1).max(500000),
          })
          .strict(),
        rows: z
          .array(
            z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
          )
          .max(1000)
          .optional(),
      },
      async ({ payload, rows }) => {
        const t = tasks.create(
          { kind: "email", payload, rows },
          `mcp:${key.id}`,
        );
        return result(tasks.confirm(t.id));
      },
    );
    server.tool(
      "create_event",
      serverMessage("mcp.createEvent"),
      { payload: eventSchema },
      async ({ payload }) => {
        const t = tasks.create({ kind: "event", payload }, `mcp:${key.id}`);
        return result(tasks.confirm(t.id));
      },
    );
    server.tool(
      "get_task",
      serverMessage("mcp.getTask"),
      { id: z.string() },
      async ({ id }) => result(tasks.get(id)),
    );
    server.tool(
      "list_templates",
      serverMessage("mcp.listTemplates"),
      {},
      async () => result(templates()),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get("/mcp", async (req, reply) =>
    reply
      .code(405)
      .send({ error: serverMessage("app.useStreamableHTTPPOSTMcp") }),
  );
  const root = options.staticRoot ?? resolve("frontend/dist");
  if (existsSync(root)) {
    await app.register(staticPlugin, { root });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/mcp"))
        return reply.code(404).send({ error: serverMessage("app.notFound") });
      return reply.sendFile("index.html");
    });
  }
  if (options.worker !== false) tasks.start();
  app.addHook("onClose", async () => {
    await tasks.stop();
    db.close();
  });
  return { app, store, tasks, ai };
}
