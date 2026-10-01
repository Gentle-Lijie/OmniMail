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

export function parseRecipients(value: string): RecipientToken[] {
  // Match display-name groups before splitting on whitespace or punctuation.
  // Never extract a valid substring from a malformed address: keep it visible.
  const parts = value.matchAll(
    /(?:"[^"\r\n]*"|[^@<>\r\n,;，；、|/\\()[\]{}:：]+)?\s*<([^<>]*)>|(?:{{\s*[^{}]+?\s*}}|[^\s,;，；、|/\\()[\]{}<>"“”‘’:：])+/g,
  );
  return Array.from(parts, (match) => {
    const value = (match[1] ?? match[0]).trim() || match[0].trim();
    return {
      kind: /{{\s*[^{}]+?\s*}}/.test(value)
        ? "placeholder"
        : isEmailAddress(value)
          ? "email"
          : "invalid",
      value,
    };
  });
}

export function normalizeRecipients(value: string): string {
  return parseRecipients(value)
    .map((token) => token.value)
    .join(";");
}
