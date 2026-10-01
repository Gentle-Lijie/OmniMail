import { z } from "zod";
import { id, type Store } from "./store.js";
import { normalizeRecipients, parseRecipients } from "./recipients.js";
const addresses = z
  .string()
  .max(10000)
  .refine(
    (s) => parseRecipients(s).every((token) => token.kind === "email"),
    "Invalid email addresses",
  )
  .transform(normalizeRecipients);
export const emailSchema = z
  .object({
    to: addresses.refine((s) => s.trim().length > 0),
    cc: addresses.default(""),
    bcc: addresses.default(""),
    subject: z.string().trim().min(1).max(998),
    html: z.string().min(1).max(500000),
  })
  .strict();
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)
  .refine((s) => {
    const d = new Date(s + "+08:00");
    return (
      Number.isFinite(d.getTime()) &&
      new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, s.length) === s
    );
  }, "Invalid Beijing timestamp");
export const eventSchema = z
  .object({
    subject: z.string().trim().min(1).max(998),
    start: timestamp,
    end: timestamp,
    requiredAttendees: addresses.default(""),
    optionalAttendees: addresses.default(""),
    location: z.string().max(2000).default(""),
    html: z.string().max(500000).default(""),
  })
  .strict()
  .refine((v) => v.end > v.start, "End must be after start");
export function validatePayload(kind: string, payload: any) {
  if (kind !== "email" && kind !== "event")
    throw new Error("Invalid task kind");
  return (kind === "email" ? emailSchema : eventSchema).parse(payload);
}
const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function renderPayload(payload: any, row: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value.replace(/{{\s*([^{}]+?)\s*}}/g, (_, field) => {
            field = field.trim();
            if (
              !Object.hasOwn(row, field) ||
              row[field] === undefined ||
              row[field] === null
            )
              throw new Error(`Missing field: ${field}`);
            return key === "html"
              ? escapeHTML(String(row[field]))
              : String(row[field]);
          })
        : value,
    ]),
  );
}
export function webhookBody(kind: string, payload: any) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text:
                kind === "email" ? "Email request" : "Calendar event request",
              wrap: true,
            },
          ],
          [kind]: payload,
        },
      },
    ],
  };
}
export function createTasks(store: Store, fetcher: typeof fetch = fetch) {
  const { db } = store;
  let busy = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (task: any) =>
    db
      .prepare("INSERT OR REPLACE INTO tasks VALUES (?,?,?)")
      .run(task.id, JSON.stringify(task), task.createdAt);
  const get = (taskId: string): any => {
    const row = db
      .prepare("SELECT value FROM tasks WHERE id=?")
      .get(taskId) as any;
    if (!row) throw new Error("Task not found");
    return JSON.parse(row.value);
  };
  const list = () =>
    (
      db
        .prepare("SELECT value FROM tasks ORDER BY createdAt DESC LIMIT 500")
        .all() as any[]
    ).map((r) => JSON.parse(r.value));
  const create = (body: any, source = "web") => {
    const schema = z.object({
      kind: z.enum(["email", "event"]),
      payload: z.record(z.any()),
      rows: z
        .array(
          z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
        )
        .min(1)
        .max(1000)
        .optional(),
      templateId: z.string().optional(),
      conversation: z.array(z.any()).max(100).optional(),
    });
    const input = schema.parse(body);
    const rows = input.rows ?? [{}];
    let renderedBytes = 0;
    const items = rows.map((row) => {
      const payload = validatePayload(
        input.kind,
        renderPayload(input.payload, row),
      );
      renderedBytes += Buffer.byteLength(JSON.stringify(payload));
      if (renderedBytes > 10 * 1024 * 1024)
        throw new Error(
          "Rendered batch exceeds 10 MB; split into smaller batches",
        );
      return { id: id(), status: "pending", payload };
    });
    if (
      input.templateId &&
      !db.prepare("SELECT id FROM templates WHERE id=?").get(input.templateId)
    )
      throw new Error("Template not found");
    const template = input.templateId
      ? JSON.parse(
          (
            db
              .prepare("SELECT value FROM templates WHERE id=?")
              .get(input.templateId) as any
          ).value,
        )
      : undefined;
    const task = {
      id: id(),
      kind: input.kind,
      source,
      status: "draft",
      createdAt: new Date().toISOString(),
      summary: input.payload.subject,
      payload: input.payload,
      items,
      total: items.length,
      accepted: 0,
      failed: 0,
      conversation: input.conversation ?? [],
      template,
    };
    save(task);
    store.audit(`task.created:${task.id}`, source);
    return task;
  };
  const aggregate = (task: any) => {
    task.accepted = task.items.filter(
      (i: any) => i.status === "accepted",
    ).length;
    task.failed = task.items.filter((i: any) => i.status === "failed").length;
  };
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const next = db
        .prepare(
          "SELECT id FROM tasks WHERE json_extract(value,'$.status') IN ('queued','running') ORDER BY createdAt LIMIT 1",
        )
        .get() as any;
      const task = next ? get(next.id) : null;
      if (!task) return;
      task.status = "running";
      save(task);
      for (const item of task.items) {
        if (stopped) break;
        if (item.status !== "pending") continue;
        const live = get(task.id);
        if (live.status === "cancelled") break;
        item.status = "running";
        save(task);
        const encrypted = store.get(
          task.kind === "email" ? "mailWebhookUrl" : "eventWebhookUrl",
        );
        try {
          if (!encrypted) {
            item.status = "failed";
            item.error = "Webhook is not configured";
          } else {
            const url = store.decrypt(encrypted);
            const res = await fetcher(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(webhookBody(task.kind, item.payload)),
              signal: AbortSignal.timeout(30000),
              redirect: "error",
            });
            item.status = res.ok
              ? "accepted"
              : res.status >= 500
                ? "uncertain"
                : "failed";
            if (!res.ok)
              item.error = `Webhook HTTP ${res.status}; inspect flow run history`;
            await res.body?.cancel();
          }
        } catch {
          item.status = "uncertain";
          item.error =
            "Delivery result unknown; inspect flow run history before retrying";
        }
        const current = get(task.id);
        const cancelled = current.status === "cancelled";
        if (cancelled)
          task.items.forEach((i: any) => {
            if (i.status === "pending") i.status = "cancelled";
          });
        aggregate(task);
        task.status = cancelled ? "cancelled" : "running";
        save(task);
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, store.get("rateLimitMs", 1000)));
      }
      if (get(task.id).status !== "cancelled") {
        task.status = task.items.some((i: any) => i.status === "uncertain")
          ? "uncertain"
          : task.failed
            ? "failed"
            : task.items.some((i: any) => i.status === "pending")
              ? "queued"
              : "accepted";
        aggregate(task);
        save(task);
      }
    } finally {
      busy = false;
    }
  };
  const schedule = () => {
    if (!stopped)
      timer = setTimeout(async () => {
        try {
          await run();
        } catch {
          store.audit("worker.error", "system");
        } finally {
          schedule();
        }
      }, 250);
  };
  const start = () => {
    for (const row of db
      .prepare(
        "SELECT id FROM tasks WHERE json_extract(value,'$.status') IN ('running','cancelled')",
      )
      .all() as any[]) {
      const task = get(row.id);
      task.items.forEach((i: any) => {
        if (i.status === "running") {
          i.status = "uncertain";
          i.error = "Server restarted during request; inspect flow history";
        }
      });
      if (task.status !== "cancelled")
        task.status = task.items.some((i: any) => i.status === "pending")
          ? "queued"
          : "uncertain";
      aggregate(task);
      save(task);
    }
    schedule();
  };
  const confirm = (taskId: string) => {
    const task = get(taskId);
    if (task.status !== "draft")
      throw new Error("Only draft tasks may be confirmed");
    task.status = "queued";
    save(task);
    store.audit(`task.confirmed:${taskId}`, task.source);
    return task;
  };
  const cancel = (taskId: string) => {
    const task = get(taskId);
    if (!["draft", "queued", "running"].includes(task.status))
      throw new Error("Task cannot be cancelled");
    task.status = "cancelled";
    task.items.forEach((i: any) => {
      if (i.status === "pending") i.status = "cancelled";
    });
    save(task);
    return task;
  };
  return {
    get,
    list,
    create,
    confirm,
    cancel,
    start,
    run,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      while (busy) await new Promise((r) => setTimeout(r, 25));
    },
  };
}
