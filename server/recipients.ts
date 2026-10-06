// Pure recipient parsing shared by the browser and task validation.
export interface RecipientToken {
  kind: "email" | "placeholder" | "invalid";
  value: string;
}

export function isEmailAddress(value: string): boolean {
  // Keep the accepted address syntax consistent with the task schema.
  return /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i.test(
    value,
  );
}

export function parseRecipients(
  value: string,
  retainUnparsed = false,
): RecipientToken[] {
  const parts = Array.from(
    value.matchAll(
      /(?:"[^"\r\n]*"|[^@<>\r\n,;，；、|/\\()[\]{}:：]+)?\s*<([^<>]*)>|(?:{{\s*[^{}]+?\s*}}|[^\s,;，；、|/\\()[\]{}<>"“”‘’:：])+/g,
    ),
  );
  const tokens: RecipientToken[] = [];
  let offset = 0;
  const remainder = (text: string) => {
    if (
      retainUnparsed &&
      text.trim() &&
      !/^[\s,;，；、|/\\()[\]:：]+$/.test(text)
    )
      tokens.push({
        kind: "invalid",
        value: text
          .trim()
          .replace(/^[\s,;，；、|/\\:：]+|[\s,;，；、|/\\:：]+$/g, ""),
      });
  };
  for (const match of parts) {
    remainder(value.slice(offset, match.index));
    const token = (match[1] ?? match[0]).trim() || match[0].trim();
    tokens.push({
      kind: /{{\s*[^{}]+?\s*}}/.test(token)
        ? "placeholder"
        : isEmailAddress(token)
          ? "email"
          : "invalid",
      value: token,
    });
    offset = match.index! + match[0].length;
  }
  remainder(value.slice(offset));
  return tokens;
}

export function normalizeRecipients(value: string): string {
  return parseRecipients(value)
    .map((token) => token.value)
    .join(";");
}

export const recipientFields = (kind: "email" | "event") =>
  kind === "email"
    ? ["to", "cc", "bcc"]
    : ["requiredAttendees", "optionalAttendees"];
export interface RecipientIssue {
  field: string;
  code: "invalid_recipient" | "recipient_required" | "duplicate_recipient";
  address?: string;
}
// Used by both the browser and server after placeholder substitution.
export function findRecipientIssues(
  kind: "email" | "event",
  payload: Record<string, string>,
  seenTargets = new Set<string>(),
): RecipientIssue[] {
  const issues: RecipientIssue[] = [],
    envelope = new Set<string>();
  for (const field of recipientFields(kind)) {
    const value = payload[field] || "";
    if (/{{/.test(value)) continue;
    const tokens = parseRecipients(value, true);
    if (!tokens.length && value.trim() && !/^[\s,;，；、|/\\:：]+$/.test(value))
      issues.push({ field, code: "invalid_recipient", address: value });
    if (field === "to" && !tokens.length)
      issues.push({ field, code: "recipient_required" });
    for (const token of tokens) {
      if (token.kind !== "email") {
        issues.push({ field, code: "invalid_recipient", address: token.value });
        continue;
      }
      const key = token.value.toLowerCase();
      if (
        envelope.has(key) ||
        (kind === "email" && field === "to" && seenTargets.has(key))
      )
        issues.push({
          field,
          code: "duplicate_recipient",
          address: token.value,
        });
      envelope.add(key);
      if (kind === "email" && field === "to") seenTargets.add(key);
    }
  }
  return issues;
}
