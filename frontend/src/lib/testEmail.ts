import { renderFields, mergeIssues, type DataRow } from "./mailMerge";
import { parseRecipients } from "./recipients";
import { message } from "./i18n";

export interface TestEmailContent {
  subject: string;
  html: string;
  row: DataRow;
  mapping: Record<string, string>;
  sample?: number;
}

export function renderTestEmail(content: TestEmailContent) {
  return {
    subject: renderFields(content.subject, content.row, content.mapping),
    html: renderFields(content.html, content.row, content.mapping, true),
  };
}

export function testEmailIssue(content: TestEmailContent, recipient: string) {
  const tokens = parseRecipients(recipient);
  if (tokens.length !== 1 || tokens[0]!.kind !== "email")
    return message("testEmail.singleRecipient");
  const issues = mergeIssues(
    "email",
    { to: recipient, subject: content.subject, html: content.html },
    [content.row],
    content.mapping,
  );
  return issues[0]?.message || "";
}
