import { z } from "zod";
import { id, type Store } from "./store.js";
import { draftFields, type AgentWorkspace } from "./agentTypes.js";
import {
  mappingSchema,
  rowSchema,
  safeKey,
  inspectDraft,
  renderDraft,
} from "./draftValidation.js";
import { createTasks } from "./tasks.js";
import { validateAttachments } from "./agentAttachments.js";
import { serverMessage } from "./i18n.js";

const payloadSchema = z.record(safeKey, z.string().max(500000));
export const draftContentSchema = z
  .object({
    title: z.string().max(200).default(""),
    kind: z.enum(["email", "event"]),
    payload: payloadSchema,
    templateId: z.string().max(200).optional(),
    rows: z.array(rowSchema).max(1000).default([]),
    columns: z.array(safeKey).max(100).default([]),
    mapping: mappingSchema.default({}),
    recipientColumn: z.string().max(200).default(""),
    manualTo: z.string().max(10000).default(""),
    fileName: z.string().max(255).default(""),
    conversation: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(20000),
          })
          .passthrough(),
      )
      .max(100)
      .default([]),
    attachments: z
      .unknown()
      .optional()
      .transform((value) => validateAttachments(value ?? [])),
    message: z.string().max(20000).default(""),
    legacyItems: z.array(payloadSchema).max(1000).default([]),
    legacyIndex: z.number().int().min(0).default(0),
    legacyNotice: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const allowed = draftFields[value.kind];
    if (
      [value.payload, ...value.legacyItems].some((payload) =>
        Object.keys(payload).some((key) => !allowed.includes(key)),
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unsupported draft field.",
      });
    if (
      new Set(value.columns).size !== value.columns.length ||
      Object.values(value.mapping).some(
        (column) => !value.columns.includes(column),
      ) ||
      (value.recipientColumn && !value.columns.includes(value.recipientColumn))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unknown or duplicate batch column.",
      });
    if (
      value.legacyItems.length &&
      (value.rows.length || value.legacyIndex >= value.legacyItems.length)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid legacy batch state.",
      });
    const sizeLimitMB = value.legacyItems.length ? 16 : 5;
    if (Buffer.byteLength(JSON.stringify(value)) > sizeLimitMB * 1024 * 1024)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Draft exceeds ${sizeLimitMB} MB. Split it into smaller drafts.`,
      });
  })
  .transform((value) => {
    value.payload = Object.fromEntries(
      draftFields[value.kind].map((field) => [
        field,
        value.payload[field] ?? "",
      ]),
    );
    if (value.legacyItems.length)
      value.legacyItems[value.legacyIndex] = { ...value.payload };
    return value;
  });
export type DraftContent = z.infer<typeof draftContentSchema>;
export interface ServerDraft extends DraftContent {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export class DraftError extends Error {
  constructor(
    public code: "draft_conflict" | "draft_not_found" | "draft_invalid",
    public statusCode: number,
  ) {
    super(serverMessage(`drafts.${code}`));
  }
}
export const expectedRevisionSchema = z.number().int().min(1);
export function createDrafts(store: Store) {
  const get = (draftId: string): ServerDraft => {
    const row = store.db
      .prepare("SELECT value FROM drafts WHERE id=?")
      .get(draftId) as { value: string } | undefined;
    if (!row) throw new DraftError("draft_not_found", 404);
    return JSON.parse(row.value);
  };
  const write = (draft: ServerDraft) => {
    store.db
      .prepare("INSERT OR REPLACE INTO drafts VALUES (?,?,?)")
      .run(draft.id, JSON.stringify(draft), draft.updatedAt);
    return structuredClone(draft);
  };
  const content = (draft: ServerDraft): DraftContent => {
    const {
      id: _id,
      revision: _revision,
      createdAt: _created,
      updatedAt: _updated,
      ...value
    } = draft;
    return value;
  };
  const create = (raw: unknown, draftId = id(), source = "web") =>
    store.db.transaction(() => {
      const value = draftContentSchema.parse(raw);
      if (store.db.prepare("SELECT id FROM drafts WHERE id=?").get(draftId)) {
        const previous = get(draftId);
        if (JSON.stringify(content(previous)) === JSON.stringify(value))
          return previous;
        throw new DraftError("draft_conflict", 409);
      }
      const now = new Date().toISOString();
      const draft = write({
        ...value,
        id: draftId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      store.audit(`draft.created:${draftId}`, source);
      return draft;
    })();
  const check = (draftId: string, expectedRevision: number) => {
    const draft = get(draftId);
    if (draft.revision !== expectedRevisionSchema.parse(expectedRevision))
      throw new DraftError("draft_conflict", 409);
    return draft;
  };
  const update = (
    draftId: string,
    expectedRevision: number,
    raw: unknown,
    source = "web",
  ) =>
    store.db.transaction(() => {
      const previous = check(draftId, expectedRevision);
      const value = draftContentSchema.parse(raw);
      // No-op saves leave reviewed versions valid.
      if (JSON.stringify(content(previous)) === JSON.stringify(value))
        return previous;
      const draft = write({
        ...value,
        id: draftId,
        createdAt: previous.createdAt,
        updatedAt: new Date().toISOString(),
        revision: previous.revision + 1,
      });
      store.audit(`draft.updated:${draftId}:${draft.revision}`, source);
      return draft;
    })();
  const list = (offset = 0, limit = 100) => {
    const rows = store.db
      .prepare(
        "SELECT value FROM drafts ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as { value: string }[];
    const total = (
      store.db.prepare("SELECT count(*) AS n FROM drafts").get() as {
        n: number;
      }
    ).n;
    return {
      drafts: rows.map((row) => {
        const draft: ServerDraft = JSON.parse(row.value);
        return {
          id: draft.id,
          title: draft.title,
          kind: draft.kind,
          revision: draft.revision,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
          total: draft.legacyItems.length || draft.rows.length || 1,
          legacyNotice: draft.legacyNotice,
        };
      }),
      total,
      hasMore: offset + rows.length < total,
    };
  };
  const remove = (draftId: string, revision: number, source = "web") =>
    store.db.transaction(() => {
      check(draftId, revision);
      store.db.prepare("DELETE FROM drafts WHERE id=?").run(draftId);
      store.audit(`draft.deleted:${draftId}`, source);
    })();
  const review = (draftId: string, revision: number, source = "web") =>
    store.db.transaction(() => {
      const draft = check(draftId, revision);
      const workspace: AgentWorkspace = {
        draftId,
        kind: draft.kind,
        payload: draft.payload,
        mapping: draft.mapping,
        recipientColumn: draft.recipientColumn,
        revision,
      };
      const issues = draft.legacyItems.length
        ? draft.legacyItems.flatMap((payload, index) =>
            inspectDraft({ ...workspace, payload }, []).map((issue) => ({
              ...issue,
              row: index + 1,
            })),
          )
        : inspectDraft(workspace, draft.rows);
      if (issues.length) throw new DraftError("draft_invalid", 400);
      const payloads = draft.legacyItems.length
        ? draft.legacyItems
        : (draft.rows.length ? draft.rows : [{}]).map((row) =>
            renderDraft(workspace, row),
          );
      const task = createTasks(store).createDraftSnapshot(
        draft.kind,
        payloads,
        source,
        { id: draftId, revision },
        {
          templateId:
            draft.templateId &&
            store.db
              .prepare("SELECT id FROM templates WHERE id=?")
              .get(draft.templateId)
              ? draft.templateId
              : undefined,
          conversation: draft.conversation,
        },
      );
      store.audit(`draft.reviewed:${draftId}:${revision}`, source);
      return task;
    })();
  const fromTask = (taskId: string, source = "web") => {
    const task = createTasks(store).get(taskId);
    const payloads = task.items.map(
      (item: { payload: Record<string, string> }) => item.payload,
    );
    return create(
      {
        title: task.summary || "",
        kind: task.kind,
        payload: payloads[0] ?? task.payload,
        templateId: task.template?.id,
        conversation: task.conversation ?? [],
        legacyItems: payloads.length > 1 ? payloads : [],
        legacyNotice: payloads.length > 1,
      },
      undefined,
      source,
    );
  };
  const migrateLegacy = () =>
    store.db.transaction(() => {
      const rows = store.db
        .prepare(
          "SELECT id,value FROM tasks WHERE json_extract(value,'$.status')='draft'",
        )
        .all() as { id: string; value: string }[];
      for (const row of rows) {
        const task = JSON.parse(row.value);
        if (
          task.sourceDraftId ||
          task.source === "web:test-email" ||
          store.get(`draftMigration:${row.id}`)
        )
          continue;
        const draft = fromTask(row.id, "migration");
        task.sourceDraftId = draft.id;
        task.sourceDraftRevision = draft.revision;
        store.db
          .prepare("UPDATE tasks SET value=? WHERE id=?")
          .run(JSON.stringify(task), row.id);
        store.set(`draftMigration:${row.id}`, draft.id);
      }
    })();
  return {
    get,
    content,
    create,
    update,
    list,
    remove,
    review,
    fromTask,
    migrateLegacy,
  };
}
