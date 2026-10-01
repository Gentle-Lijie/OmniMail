import { message } from "./i18n";
import type { Kind, Payload } from "./api";
import { parseRecipients } from "./recipients";
export type DataRow = Record<string, unknown>;
export interface MergeIssue {
  row: number;
  field: string;
  message: string;
}
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
export function fieldsIn(payload: Payload): string[] {
  return [
    ...new Set(
      Object.values(payload).flatMap((value) =>
        [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) =>
          match[1]!.trim(),
        ),
      ),
    ),
  ];
}
export function renderFields(
  value: string,
  row: DataRow,
  mapping: Record<string, string>,
  html = false,
): string {
  return value.replace(/{{\s*([^{}]+?)\s*}}/g, (token, field: string) => {
    const column = mapping[field.trim()] || field.trim();
    const replacement = Object.hasOwn(row, column) ? row[column] : undefined;
    return replacement === undefined || replacement === null
      ? token
      : html
        ? escapeHtml(replacement)
        : String(replacement);
  });
}
export function mappedRows(
  rows: DataRow[],
  mapping: Record<string, string>,
): DataRow[] {
  return rows.map((row) =>
    Object.assign(
      {},
      row,
      Object.fromEntries(
        Object.entries(mapping)
          .filter(([, column]) => !!column)
          .map(([field, column]) => [field, row[column]]),
      ),
    ),
  );
}
export function recommendedEmailColumn(columns: string[]): string {
  const matches = columns.filter((column) =>
    /^(email|e-mail|email_address|邮箱|电子邮箱|收件邮箱|收件人邮箱)$/i.test(
      column.trim(),
    ),
  );
  return matches.length === 1 ? matches[0]! : "";
}
export function mergeIssues(
  kind: Kind,
  payload: Payload,
  rows: DataRow[],
  mapping: Record<string, string>,
): MergeIssue[] {
  const issues: MergeIssue[] = [];
  const seen = new Set<string>();
  const fields = fieldsIn(payload);
  const recipients =
    kind === "email"
      ? ["to", "cc", "bcc"]
      : ["requiredAttendees", "optionalAttendees"];
  const samples = rows.length ? rows : [{}];
  samples.forEach((row, rowIndex) => {
    const position = rows.length ? rowIndex + 1 : 0;
    for (const field of fields) {
      const column = mapping[field] || field;
      const value = Object.hasOwn(row, column) ? row[column] : undefined;
      if (value === undefined || value === null || String(value).trim() === "")
        issues.push({
          row: position,
          field,
          message: message("mailMerge.missingField"),
        });
    }
    for (const field of recipients) {
      const rendered = renderFields(payload[field] || "", row, mapping);
      const addresses = parseRecipients(rendered);
      if (field === "to" && !addresses.length)
        issues.push({
          row: position,
          field,
          message: message("mailMerge.recipientRequired"),
        });
      if (/{{/.test(rendered)) continue;
      for (const token of addresses) {
        const address = token.value;
        if (token.kind !== "email")
          issues.push({
            row: position,
            field,
            message: message("mailMerge.invalidEmail", { address }),
          });
        if (field === "to") {
          const normalized = address.toLowerCase();
          if (seen.has(normalized))
            issues.push({
              row: position,
              field,
              message: message("mailMerge.duplicateRecipient", { address }),
            });
          seen.add(normalized);
        }
      }
    }
    const subject = renderFields(payload.subject, row, mapping);
    if (!subject.trim())
      issues.push({
        row: position,
        field: "subject",
        message: message("mailMerge.subjectRequired"),
      });
    if (kind === "email" && !payload.html.trim())
      issues.push({
        row: position,
        field: "html",
        message: message("mailMerge.bodyRequired"),
      });
    if (kind === "event") {
      const start = renderFields(payload.start || "", row, mapping),
        end = renderFields(payload.end || "", row, mapping);
      if (
        !start ||
        !end ||
        !Number.isFinite(Date.parse(start)) ||
        !Number.isFinite(Date.parse(end)) ||
        end <= start
      )
        issues.push({
          row: position,
          field: "start",
          message: message("mailMerge.invalidEventTimes"),
        });
    }
  });
  return issues;
}
export function previewDocument(html: string, dark = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>body{margin:24px;font:14px/1.8 system-ui;background:${dark ? "#182131" : "#fff"};color:${dark ? "#e0e7f4" : "#253249"};overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}h1,h2,h3{line-height:1.4}a{color:#3468ed}</style></head><body>${html}</body></html>`;
}
