import { serverMessage } from "./i18n.js";
import {
  isEmailAddress,
  parseRecipients,
  recipientFields,
  findRecipientIssues,
} from "./recipients.js";
import type { DraftContent } from "./drafts.js";

export interface RepairChange {
  row: number;
  field: string;
  before: string;
  after: string;
  reason: "normalize" | "duplicate" | "replace" | "exclude";
}
export interface RepairReport {
  changedCells: number;
  duplicateAddresses: number;
  removedRows: number;
  unresolvedCount: number;
  changes: RepairChange[];
  unresolved: { row: number; field: string; address: string }[];
  unsupportedFields: string[];
  remainingRows: number;
}
export interface RepairOptions {
  replacements?: Record<string, string>;
  excludeRows?: number[];
}
export function widthNormalize(value: string) {
  return value
    .replace(/[\uFF01-\uFF5E]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/\u3000/g, " ")
    .trim();
}
function repairList(
  value: string,
  seen: Set<string>,
  replacements: Record<string, string>,
) {
  const normalized = widthNormalize(value),
    tokens = parseRecipients(normalized, true);
  const result: string[] = [],
    unresolved: string[] = [];
  let duplicates = 0,
    replaced = false;
  for (const token of tokens) {
    let address = token.value;
    const replacement = replacements[address.toLowerCase()];
    if (replacement !== undefined) {
      address = replacement;
      replaced = true;
    }
    if (isEmailAddress(address)) {
      const at = address.lastIndexOf("@");
      address = address.slice(0, at) + address.slice(at).toLowerCase();
      const key = address.toLowerCase();
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
    } else if (token.kind !== "placeholder") unresolved.push(address);
    result.push(address);
  }
  // Retain unsupported punctuation-only values instead of silently dropping them.
  if (
    !tokens.length &&
    normalized &&
    !/^[\s,;，；、|/\\:：]+$/.test(normalized)
  ) {
    result.push(normalized);
    unresolved.push(normalized);
  }
  return { value: result.join(";"), duplicates, replaced, unresolved };
}
export function repairDraftRecipients(
  input: DraftContent,
  options: RepairOptions = {},
) {
  if (input.legacyItems.length)
    throw Error(serverMessage("recipientRepair.legacyUnavailable"));
  const draft: DraftContent = structuredClone(input);
  const report: RepairReport = {
    changedCells: 0,
    duplicateAddresses: 0,
    removedRows: 0,
    unresolvedCount: 0,
    changes: [],
    unresolved: [],
    unsupportedFields: [],
    remainingRows: input.rows.length,
  };
  const replacements: Record<string, string> = Object.create(null);
  for (const [before, after] of Object.entries(options.replacements ?? {})) {
    const key = widthNormalize(before).toLowerCase(),
      to = widthNormalize(after);
    if (!key || parseRecipients(key).length !== 1 || !isEmailAddress(to))
      throw Error(serverMessage("recipientRepair.invalidReplacement"));
    if (Object.hasOwn(replacements, key) && replacements[key] !== to)
      throw Error(serverMessage("recipientRepair.conflictingReplacement"));
    replacements[key] = to;
  }
  const record = (
    row: number,
    field: string,
    before: string,
    after: string,
    result: { duplicates: number; replaced: boolean; unresolved: string[] },
  ) => {
    report.duplicateAddresses += result.duplicates;
    report.unresolved.push(
      ...result.unresolved.map((address) => ({ row, field, address })),
    );
    if (before !== after) {
      report.changedCells++;
      report.changes.push({
        row,
        field,
        before,
        after,
        reason: result.replaced
          ? "replace"
          : result.duplicates
            ? "duplicate"
            : "normalize",
      });
    }
  };
  const primary = input.kind === "email" ? "to" : "requiredAttendees";
  const fields = recipientFields(input.kind);
  // Literal fields can be repaired without touching any merge placeholders.
  const envelope = new Set<string>();
  for (const field of fields) {
    const before = draft.payload[field] || "";
    if (/{{/.test(before)) continue;
    const repaired = repairList(before, envelope, replacements);
    draft.payload[field] = repaired.value;
    record(0, field, before, repaired.value, repaired);
  }
  const excluded = new Set(options.excludeRows ?? []);
  if (
    [...excluded].some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index >= draft.rows.length,
    )
  )
    throw Error(serverMessage("recipientRepair.invalidRow"));
  if (draft.rows.length) {
    if (!draft.recipientColumn)
      throw Error(serverMessage("recipientRepair.confirmColumn"));
    const primaryToken = draft.payload[primary]?.match(/^{{\s*([^{}]+?)\s*}}$/);
    const primaryColumn = primaryToken
      ? draft.mapping[primaryToken[1].trim()] || primaryToken[1].trim()
      : "";
    if (primaryColumn !== draft.recipientColumn)
      report.unsupportedFields.push(primary);
    const seenTargets = new Set<string>();
    draft.rows = draft.rows.filter((row, index) => {
      if (excluded.has(index)) {
        report.removedRows++;
        report.changes.push({
          row: index + 1,
          field: primary,
          before: String(row[draft.recipientColumn] ?? ""),
          after: "",
          reason: "exclude",
        });
        return false;
      }
      const rowEnvelope = new Set<string>();
      let remove = false;
      for (const field of fields) {
        const token = draft.payload[field]?.match(/^{{\s*([^{}]+?)\s*}}$/);
        if (!token) {
          if (
            /{{/.test(draft.payload[field] || "") &&
            !report.unsupportedFields.includes(field)
          )
            report.unsupportedFields.push(field);
          else
            for (const entry of parseRecipients(draft.payload[field] || ""))
              if (entry.kind === "email")
                rowEnvelope.add(entry.value.toLowerCase());
          continue;
        }
        const column = draft.mapping[token[1].trim()] || token[1].trim();
        if (!draft.columns.includes(column)) {
          if (!report.unsupportedFields.includes(field))
            report.unsupportedFields.push(field);
          continue;
        }
        if (field === primary && primaryColumn !== draft.recipientColumn)
          continue;
        // A column shared by primary and copy fields cannot be cleared for only one field.
        if (field !== primary && column === primaryColumn) {
          if (!report.unsupportedFields.includes(field))
            report.unsupportedFields.push(field);
          continue;
        }
        const before = String(row[column] ?? "");
        const seen =
          field === primary && input.kind === "email"
            ? seenTargets
            : rowEnvelope;
        const repaired = repairList(before, seen, replacements);
        row[column] = repaired.value;
        for (const entry of parseRecipients(repaired.value))
          if (entry.kind === "email")
            rowEnvelope.add(entry.value.toLowerCase());
        record(index + 1, column, before, repaired.value, repaired);
        if (
          field === primary &&
          input.kind === "email" &&
          !repaired.value &&
          repaired.duplicates > 0 &&
          !repaired.unresolved.length
        )
          remove = true;
      }
      if (remove) report.removedRows++;
      return !remove;
    });
    if (!draft.rows.length) {
      // Empty batches must not accidentally turn into a manual send.
      draft.payload[primary] = "";
      draft.manualTo = "";
      draft.recipientColumn = "";
    }
  }
  report.unresolved = [];
  const seen = new Set<string>();
  for (const [index, row] of (draft.rows.length
    ? draft.rows
    : [{}]
  ).entries()) {
    const record: Record<string, unknown> = row;
    const rendered = Object.fromEntries(
      recipientFields(draft.kind).map((field) => [
        field,
        (draft.payload[field] || "").replace(
          /{{\s*([^{}]+?)\s*}}/g,
          (token, name: string) => {
            const column = draft.mapping[name.trim()] || name.trim();
            const value = Object.hasOwn(record, column)
              ? record[column]
              : undefined;
            return value === undefined || value === null
              ? token
              : String(value);
          },
        ),
      ]),
    );
    for (const issue of findRecipientIssues(draft.kind, rendered, seen))
      report.unresolved.push({
        row: draft.rows.length ? index + 1 : 0,
        field: issue.field,
        address: issue.address || "",
      });
  }
  report.unresolvedCount = report.unresolved.length;
  report.remainingRows = draft.rows.length;
  return { draft, report };
}

export function recipientRepairFingerprint(draft: DraftContent) {
  return JSON.stringify([
    draft.kind,
    recipientFields(draft.kind).map((field) => draft.payload[field] || ""),
    draft.rows,
    draft.columns,
    draft.mapping,
    draft.recipientColumn,
    draft.manualTo,
    draft.fileName,
    draft.legacyItems,
  ]);
}
