import { z } from "zod";
import { createTemplates, templateSchema } from "./templates.js";
import { createTasks } from "./tasks.js";
import { hash, id, type Store } from "./store.js";
import { serverMessage } from "./i18n.js";
import {
  draftFields,
  type AgentProgress,
  type AgentWorkspace,
} from "./agentTypes.js";
import { type AgentAttachment } from "./agentAttachments.js";
import {
  fieldsIn,
  inspectDraft,
  renderDraft,
  mappingSchema,
  safeKey,
  type BatchRow,
} from "./draftValidation.js";

// The registry uses the same Zod schemas for provider declarations and execution.
export function toolJSONSchema(schema: z.ZodTypeAny): any {
  const def = schema._def;
  if (["ZodOptional", "ZodDefault"].includes(def.typeName))
    return toolJSONSchema(def.innerType);
  if (def.typeName === "ZodEffects") return toolJSONSchema(def.schema);
  if (def.typeName === "ZodObject") {
    const shape = def.shape();
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [
          key,
          toolJSONSchema(value as z.ZodTypeAny),
        ]),
      ),
      required: Object.entries(shape)
        .filter(([, value]) => !(value as z.ZodTypeAny).isOptional())
        .map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (def.typeName === "ZodRecord")
    return {
      type: "object",
      additionalProperties: toolJSONSchema(def.valueType),
    };
  if (def.typeName === "ZodArray")
    return {
      type: "array",
      items: toolJSONSchema(def.type),
      ...(def.maxLength ? { maxItems: def.maxLength.value } : {}),
    };
  if (def.typeName === "ZodEnum") return { type: "string", enum: def.values };
  if (def.typeName === "ZodLiteral")
    return { type: typeof def.value, enum: [def.value] };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodString") {
    const result: any = { type: "string" };
    for (const check of def.checks) {
      if (check.kind === "min") result.minLength = check.value;
      if (check.kind === "max") result.maxLength = check.value;
      if (check.kind === "regex") result.pattern = check.regex.source;
    }
    return result;
  }
  if (def.typeName === "ZodNumber") {
    const result: any = {
      type: def.checks.some((check: any) => check.kind === "int")
        ? "integer"
        : "number",
    };
    for (const check of def.checks) {
      if (check.kind === "min") result.minimum = check.value;
      if (check.kind === "max") result.maximum = check.value;
    }
    return result;
  }
  throw Error(`Unsupported tool schema: ${def.typeName}`);
}

const identifier = z.string().min(1).max(200);
const version = z.number().int().positive();
const paging = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
};
const templateRef = { id: identifier, expectedVersion: version };
export interface ToolContext {
  workspace: AgentWorkspace;
  rows: BatchRow[];
  columns: string[];
  attachments: AgentAttachment[];
  conversation: unknown[];
  requestId?: string;
  principal?: string;
  onProgress?: (event: AgentProgress) => void;
  signal?: AbortSignal;
}
interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  execute: (args: any) => unknown;
  persistent: boolean;
}
export function createAgentTools(store: Store, context: ToolContext) {
  const templates = createTemplates(store);
  // Tools deliberately have no worker and no confirm/send entry point.
  const tasks = createTasks(store);
  let workspace: AgentWorkspace = structuredClone(context.workspace);
  let saved: { fingerprint: string; taskId: string } | undefined;
  let reviewTaskId: string | undefined;
  let changed = false;
  const definitions: ToolDefinition[] = [];
  const emit = (event: AgentProgress) => context.onProgress?.(event);
  const state = () => structuredClone(workspace);
  const checkRevision = (revision: number) => {
    if (revision !== workspace.revision)
      throw Error("Draft changed. Read its latest revision before editing.");
  };
  const change = (patch: Partial<AgentWorkspace>) => {
    workspace = { ...workspace, ...patch, revision: workspace.revision + 1 };
    changed = true;
    saved = undefined;
    reviewTaskId = undefined;
    emit({ type: "workspace", workspace: state() });
    return state();
  };
  const assertColumns = (mapping: Record<string, string>) => {
    for (const column of Object.values(mapping))
      if (!context.columns.includes(column))
        throw Error(`Unknown batch column: ${column}`);
  };
  const validate = () => {
    const issues = inspectDraft(workspace, context.rows);
    return {
      valid: !issues.length,
      total: context.rows.length || 1,
      issueCount: issues.length,
      issues: issues.slice(0, 100),
      truncated: issues.length > 100,
      revision: workspace.revision,
    };
  };
  const assertValid = () => {
    const validation = validate();
    if (!validation.valid)
      throw Error(
        `Draft validation failed: ${JSON.stringify(validation.issues.slice(0, 5))}`,
      );
  };
  const renderedRows = () =>
    context.rows.length
      ? context.rows.map((row) =>
          Object.assign(
            {},
            row,
            Object.fromEntries(
              Object.entries(workspace.mapping).map(([field, column]) => [
                field,
                row[column],
              ]),
            ),
          ),
        )
      : undefined;
  const fingerprint = () => hash(JSON.stringify([workspace, context.rows]));
  const save = () => {
    assertValid();
    const current = fingerprint();
    if (
      saved?.fingerprint === current &&
      tasks.get(saved.taskId).status === "draft"
    )
      return tasks.get(saved.taskId);
    const task = tasks.create(
      {
        kind: workspace.kind,
        payload: workspace.payload,
        rows: renderedRows(),
        templateId: workspace.templateId,
        conversation: context.conversation,
      },
      "agent",
    );
    saved = { fingerprint: current, taskId: task.id };
    emit({ type: "refresh" });
    return task;
  };
  const rowAt = (rowIndex: number) => {
    if (!context.rows.length && rowIndex === 0) return {};
    if (rowIndex >= context.rows.length)
      throw Error("Batch row index is out of range (zero-based).");
    return context.rows[rowIndex];
  };
  const preview = (rowIndex = 0) => ({
    rowIndex,
    payload: renderDraft(workspace, rowAt(rowIndex)),
    revision: workspace.revision,
  });
  const add = (
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    execute: ToolDefinition["execute"],
    persistent = false,
  ) => definitions.push({ name, description, schema, execute, persistent });
  const templateChanged = <T>(value: T) => {
    emit({ type: "refresh" });
    return value;
  };
  const summary = (template: ReturnType<typeof templates.get>) => {
    const { html, ...rest } = template;
    return { ...rest, htmlLength: html.length };
  };

  add(
    "list_templates",
    "Search templates by name/description and kind. Returns summaries and versions, not full HTML.",
    z
      .object({
        query: z.string().max(200).default(""),
        kind: z.enum(["email", "event"]).optional(),
        ...paging,
      })
      .strict(),
    ({ query, kind, offset, limit }) => {
      const matches = templates
        .list()
        .filter(
          (t) =>
            (!kind || t.kind === kind) &&
            `${t.name} ${t.description} ${t.subject}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        );
      return {
        total: matches.length,
        templates: matches.slice(offset, offset + limit).map(summary),
      };
    },
  );
  add(
    "get_template",
    "Read a template's complete content, fields and current version before modifying it.",
    z.object({ id: identifier }).strict(),
    ({ id }) => templates.get(id),
  );
  add(
    "create_template",
    "Create a reusable template and persist version 1 immediately.",
    templateSchema,
    (args) => templateChanged(templates.create(args, "agent")),
    true,
  );
  add(
    "update_template",
    "Patch a template and persist a new version; expectedVersion must match. Preserve placeholders unless asked otherwise.",
    z
      .object({
        ...templateRef,
        patch: templateSchema
          .partial()
          .refine((p) => Object.keys(p).length > 0),
      })
      .strict(),
    ({ id, patch, expectedVersion }) =>
      templateChanged(templates.update(id, patch, expectedVersion, "agent")),
    true,
  );
  add(
    "delete_template",
    "Delete the named template after reading it; existing tasks retain snapshots. Requires its current version.",
    z.object(templateRef).strict(),
    ({ id, expectedVersion }) => {
      const result = templates.remove(id, expectedVersion, "agent");
      if (workspace.templateId === id) change({ templateId: undefined });
      return templateChanged(result);
    },
    true,
  );
  add(
    "list_template_versions",
    "List historical versions of an existing template, including content; paginated.",
    z.object({ id: identifier, ...paging }).strict(),
    ({ id, offset, limit }) => {
      const versions = templates.versions(id);
      return {
        total: versions.length,
        versions: versions.slice(offset, offset + limit),
      };
    },
  );
  add(
    "rollback_template",
    "Restore historical template content as a new version, using the current expectedVersion.",
    z.object({ ...templateRef, version }).strict(),
    ({ id, version, expectedVersion }) =>
      templateChanged(
        templates.rollback(id, version, expectedVersion, "agent"),
      ),
    true,
  );

  add(
    "get_current_draft",
    "Read the current working draft, editable fields, template, mapping and revision.",
    z.object({}).strict(),
    () => ({
      ...state(),
      fields: draftFields[workspace.kind],
      rowCount: context.rows.length,
    }),
  );
  add(
    "update_current_draft",
    "Immediately patch fields of the current draft. Requires the latest expectedRevision; only fields for its kind are accepted.",
    z
      .object({
        draftId: identifier,
        expectedRevision: z.number().int().min(0),
        patch: z
          .record(
            z.enum([...new Set(Object.values(draftFields).flat())] as [
              string,
              ...string[],
            ]),
            z.string().max(500000),
          )
          .refine((p) => Object.keys(p).length > 0),
      })
      .strict(),
    ({ draftId, expectedRevision, patch }) => {
      if (draftId !== workspace.draftId)
        throw Error("Draft ID does not match the current workspace.");
      checkRevision(expectedRevision);
      if (
        Object.keys(patch).some(
          (field) => !draftFields[workspace.kind].includes(field),
        )
      )
        throw Error("Unsupported field for this draft kind.");
      return change({ payload: { ...workspace.payload, ...patch } });
    },
  );
  add(
    "apply_template",
    "Apply a compatible template to the current draft's subject and body, retaining recipients, batch data and event details.",
    z
      .object({ id: identifier, expectedRevision: z.number().int().min(0) })
      .strict(),
    ({ id, expectedRevision }) => {
      checkRevision(expectedRevision);
      const template = templates.get(id);
      if (template.kind !== workspace.kind)
        throw Error("Template kind does not match the current draft.");
      return change({
        payload: {
          ...workspace.payload,
          subject: template.subject,
          html: template.html,
        },
        templateId: id,
      });
    },
  );
  add(
    "save_draft",
    "Validate and save the current draft as a server draft task. Never queues or sends it.",
    z.object({}).strict(),
    () => {
      const task = save();
      return {
        id: task.id,
        status: task.status,
        total: task.total,
        summary: task.summary,
      };
    },
    true,
  );
  add(
    "preview_draft",
    "Render the current draft or one batch row (zero-based rowIndex), escaping HTML substitutions. Returns recipients and body.",
    z.object({ rowIndex: z.number().int().min(0).default(0) }).strict(),
    ({ rowIndex }) => preview(rowIndex),
  );

  add(
    "get_batch_schema",
    "Read batch column names, count, confirmed recipient column and field mapping, without exposing full rows.",
    z.object({}).strict(),
    () => ({
      columns: context.columns,
      rowCount: context.rows.length,
      recipientColumn: workspace.recipientColumn,
      mapping: workspace.mapping,
      fields: fieldsIn(workspace.payload),
      revision: workspace.revision,
    }),
  );
  add(
    "set_field_mapping",
    "Set placeholder-to-column mappings. Optional recipientColumn explicitly selects the recipient column and updates its placeholder.",
    z
      .object({
        expectedRevision: z.number().int().min(0),
        mapping: mappingSchema,
        recipientColumn: safeKey.optional(),
      })
      .strict(),
    ({ mapping, recipientColumn, expectedRevision }) => {
      checkRevision(expectedRevision);
      assertColumns(mapping);
      const nextMapping = { ...workspace.mapping, ...mapping };
      let payload = workspace.payload;
      if (recipientColumn !== undefined) {
        if (!context.columns.includes(recipientColumn))
          throw Error("Unknown recipient column.");
        nextMapping[recipientColumn] = recipientColumn;
        payload = {
          ...payload,
          [workspace.kind === "email" ? "to" : "requiredAttendees"]:
            `{{${recipientColumn}}}`,
        };
      }
      return change({
        mapping: nextMapping,
        payload,
        recipientColumn: recipientColumn ?? workspace.recipientColumn,
      });
    },
  );
  add(
    "validate_draft",
    "Validate every row for missing placeholders, recipient addresses, duplicate targets, required fields and valid Beijing event times.",
    z.object({}).strict(),
    validate,
  );
  add(
    "get_batch_row",
    "Read only one relevant row of the imported batch by zero-based index; optional columns restrict returned values.",
    z
      .object({
        rowIndex: z.number().int().min(0),
        columns: z.array(safeKey).max(100).optional(),
      })
      .strict(),
    ({ rowIndex, columns }) => {
      if (!context.rows.length) throw Error("No batch is imported.");
      const row = rowAt(rowIndex);
      const selected: string[] = columns ?? context.columns;
      if (selected.some((column) => !context.columns.includes(column)))
        throw Error("Unknown batch column.");
      return {
        rowIndex,
        row: Object.fromEntries(
          selected.map((column) => [column, row[column] ?? null]),
        ),
      };
    },
  );

  add(
    "list_tasks",
    "Search task summaries by status, kind, subject and Beijing calendar date. Paginated over all stored tasks; no recipient content included.",
    z
      .object({
        query: z.string().max(200).default(""),
        kind: z.enum(["email", "event"]).optional(),
        status: z
          .enum([
            "draft",
            "queued",
            "running",
            "accepted",
            "failed",
            "uncertain",
            "cancelled",
          ])
          .optional(),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        ...paging,
      })
      .strict(),
    ({ query, kind, status, from, to, offset, limit }) => {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (kind) {
        conditions.push("json_extract(value,'$.kind')=?");
        params.push(kind);
      }
      if (status) {
        conditions.push("json_extract(value,'$.status')=?");
        params.push(status);
      }
      if (query) {
        conditions.push(
          "instr(lower(json_extract(value,'$.summary')),lower(?))>0",
        );
        params.push(query);
      }
      if (from) {
        conditions.push("date(createdAt,'+8 hours')>=?");
        params.push(from);
      }
      if (to) {
        conditions.push("date(createdAt,'+8 hours')<=?");
        params.push(to);
      }
      const where = conditions.length
        ? ` WHERE ${conditions.join(" AND ")}`
        : "";
      const total = (
        store.db
          .prepare(`SELECT count(*) AS n FROM tasks${where}`)
          .get(...params) as { n: number }
      ).n;
      const rows = store.db
        .prepare(
          `SELECT value FROM tasks${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as { value: string }[];
      return {
        total,
        tasks: rows
          .map((row) => JSON.parse(row.value))
          .map(({ items, payload, conversation, template, ...task }) => ({
            ...task,
            templateId: template?.id,
          })),
      };
    },
  );
  add(
    "get_task",
    "Read a task's draft/content and paginated item results. accepted means webhook acceptance, not verified delivery.",
    z.object({ id: identifier, ...paging }).strict(),
    ({ id, offset, limit }) => {
      const task = tasks.get(id);
      return {
        ...task,
        conversation: undefined,
        items: task.items.slice(offset, offset + limit),
        itemOffset: offset,
      };
    },
  );
  add(
    "cancel_task",
    "Cancel a draft/queued/running task's remaining items. Cannot recall sent emails or cancel an Outlook event.",
    z.object({ id: identifier }).strict(),
    ({ id }) => {
      const task = tasks.cancel(id);
      emit({ type: "refresh" });
      return {
        id: task.id,
        status: task.status,
        total: task.total,
        accepted: task.accepted,
        failed: task.failed,
      };
    },
    true,
  );
  add(
    "prepare_execution",
    "Validate and prepare an execution summary with a sample and counts. Does not save, queue or send.",
    z.object({}).strict(),
    () => ({
      ...validate(),
      kind: workspace.kind,
      subject: workspace.payload.subject,
      sample: preview(0),
      requiresHumanConfirmation: true,
    }),
  );
  add(
    "request_execution_confirmation",
    "Validate and save the current draft, then open explicit human review. This tool never confirms, queues or sends.",
    z.object({}).strict(),
    () => {
      const task = save();
      reviewTaskId = task.id;
      emit({ type: "review", taskId: task.id });
      return {
        id: task.id,
        status: task.status,
        total: task.total,
        requiresHumanConfirmation: true,
        queued: false,
      };
    },
    true,
  );

  const attachments = context.attachments.map((attachment) => ({
    ...attachment,
    id: hash(
      `${attachment.name}\0${attachment.kind}\0${attachment.kind === "text" ? attachment.text : attachment.data}`,
    ).slice(0, 24),
  }));
  const attachmentGet = (attachmentId: string) => {
    const attachment = attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw Error("Attachment not found in this conversation.");
    return attachment;
  };
  add(
    "read_attachment",
    "Read an uploaded reference attachment by its stable ID, in bounded text slices. Images return metadata; their pixels are already available to the vision model.",
    z
      .object({
        id: identifier,
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(12000).default(6000),
      })
      .strict(),
    ({ id, offset, length }) => {
      const attachment = attachmentGet(id);
      if (attachment.kind === "image")
        return {
          id,
          name: attachment.name,
          kind: attachment.kind,
          mediaType: attachment.mediaType,
          size: attachment.size,
        };
      if (offset > attachment.text.length)
        throw Error("Attachment offset is out of range.");
      return {
        id,
        name: attachment.name,
        kind: attachment.kind,
        offset,
        totalLength: attachment.text.length,
        text: attachment.text.slice(offset, offset + length),
        hasMore: offset + length < attachment.text.length,
      };
    },
  );
  add(
    "search_attachment",
    "Search uploaded text documents by literal case-insensitive keyword; return bounded excerpts with character offsets and IDs.",
    z
      .object({
        query: z.string().trim().min(1).max(200),
        id: identifier.optional(),
        limit: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
    ({ query, id, limit }) => {
      const matches: {
        id: string;
        name: string;
        offset: number;
        text: string;
      }[] = [];
      for (const attachment of id ? [attachmentGet(id)] : attachments) {
        if (attachment.kind !== "text") continue;
        const lower = attachment.text.toLowerCase();
        let offset = 0;
        while (matches.length < limit) {
          const position = lower.indexOf(query.toLowerCase(), offset);
          if (position < 0) break;
          const start = Math.max(0, position - 160);
          matches.push({
            id: attachment.id,
            name: attachment.name,
            offset: start,
            text: attachment.text.slice(start, position + query.length + 300),
          });
          offset = position + query.length;
        }
      }
      return { matches, limit };
    },
  );

  const scope = hash(
    `${context.principal ?? "local"}:${context.requestId ?? id()}`,
  );
  const execute = (name: string, raw: unknown) => {
    if (context.signal?.aborted)
      throw context.signal.reason ?? Error("Agent cancelled.");
    const definition = definitions.find((tool) => tool.name === name);
    if (!definition) throw Error(serverMessage("agentTools.invalidTool"));
    const args = definition.schema.parse(raw);
    const key = hash(JSON.stringify([name, args]));
    if (!definition.persistent) return definition.execute(args);
    const result = store.db.transaction(() => {
      const previous = store.db
        .prepare(
          "SELECT value FROM agent_operations WHERE scope=? AND operation=?",
        )
        .get(scope, key) as { value: string } | undefined;
      if (previous) {
        const cached = JSON.parse(previous.value);
        // Replay completion events so a disconnected client can reconcile safely.
        if (cached.workspace) {
          workspace = cached.workspace;
          changed = true;
          emit({ type: "workspace", workspace: state() });
        }
        if (cached.saved) saved = cached.saved;
        if (cached.reviewTaskId) {
          reviewTaskId = cached.reviewTaskId;
          emit({ type: "review", taskId: reviewTaskId });
        }
        emit({ type: "refresh" });
        return cached.result;
      }
      const previousRevision = workspace.revision;
      const result = definition.execute(args);
      store.db.prepare("INSERT INTO agent_operations VALUES (?,?,?,?)").run(
        scope,
        key,
        JSON.stringify({
          result,
          saved,
          reviewTaskId,
          workspace:
            previousRevision !== workspace.revision ? state() : undefined,
        }),
        Date.now(),
      );
      return result;
    })();
    return result;
  };
  return {
    definitions: definitions.map(({ name, description, schema }) => ({
      name,
      description,
      parameters: toolJSONSchema(schema),
    })),
    execute,
    state,
    changed: () => changed,
    reviewTaskId: () => reviewTaskId,
    attachmentIndex: attachments.map(({ id, name, kind, size }) => ({
      id,
      name,
      kind,
      size,
    })),
  };
}
export type AgentTools = ReturnType<typeof createAgentTools>;
