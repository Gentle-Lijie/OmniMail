import { z } from "zod";
import { findRecipientIssues } from "./recipients.js";
import { validatePayload } from "./tasks.js";
import type { AgentWorkspace } from "./agentTypes.js";

export type BatchRow = Record<string, string | number | boolean | null>;
export const safeKey = z
  .string()
  .min(1)
  .max(200)
  .refine((key) => !["__proto__", "constructor", "prototype"].includes(key));
export const rowSchema = z.record(
  safeKey,
  z.union([z.string().max(500000), z.number().finite(), z.boolean(), z.null()]),
);
export const mappingSchema = z
  .record(safeKey, safeKey)
  .refine((value) => Object.keys(value).length <= 100);
export const fieldsIn = (payload: Record<string, string>) => [
  ...new Set(
    Object.values(payload).flatMap((value) =>
      [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) =>
        match[1].trim(),
      ),
    ),
  ),
];
export const escapeHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function renderDraft(workspace: AgentWorkspace, row: BatchRow = {}) {
  return Object.fromEntries(
    Object.entries(workspace.payload).map(([key, value]) => [
      key,
      value.replace(/{{\s*([^{}]+?)\s*}}/g, (token, field: string) => {
        const column = workspace.mapping[field.trim()] || field.trim();
        const item = Object.hasOwn(row, column) ? row[column] : undefined;
        return item === undefined || item === null
          ? token
          : key === "html"
            ? escapeHTML(item)
            : String(item);
      }),
    ]),
  );
}
export interface DraftIssue {
  row: number;
  field: string;
  code: string;
  message: string;
}
export function inspectDraft(
  workspace: AgentWorkspace,
  rows: BatchRow[],
  seen = new Set<string>(),
) {
  const issues: DraftIssue[] = [];
  const add = (row: number, field: string, code: string, message: string) =>
    issues.push({ row, field, code, message });
  if (rows.length && !workspace.recipientColumn)
    add(
      0,
      "recipientColumn",
      "recipient_column_required",
      "Confirm the recipient column before saving or executing a batch.",
    );
  for (const [index, row] of (rows.length ? rows : [{}]).entries()) {
    const position = rows.length ? index + 1 : 0;
    for (const field of fieldsIn(workspace.payload)) {
      const column = workspace.mapping[field] || field;
      const value = Object.hasOwn(row, column) ? row[column] : undefined;
      if (value === undefined || value === null || String(value).trim() === "")
        add(position, field, "missing_field", `Missing value for ${field}.`);
    }
    const payload = renderDraft(workspace, row);
    try {
      validatePayload(workspace.kind, payload);
    } catch (error) {
      if (error instanceof z.ZodError)
        for (const issue of error.issues)
          add(
            position,
            issue.path.join(".") || "payload",
            "invalid_payload",
            issue.message,
          );
      else
        add(
          position,
          "payload",
          "invalid_payload",
          error instanceof Error ? error.message : "Invalid payload.",
        );
    }
    for (const issue of findRecipientIssues(workspace.kind, payload, seen))
      add(
        position,
        issue.field,
        issue.code,
        issue.code === "duplicate_recipient"
          ? `Duplicate recipient: ${issue.address}`
          : issue.code === "recipient_required"
            ? "Recipient is required."
            : `Invalid recipient: ${issue.address}`,
      );
  }
  return issues;
}
