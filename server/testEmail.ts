import { z } from "zod";
import { fieldsIn, mappingSchema, rowSchema } from "./draftValidation.js";
import { parseRecipients, normalizeRecipients } from "./recipients.js";
import { renderPayload, emailSchema } from "./tasks.js";
import { serverMessage } from "./i18n.js";

export function testEmailPayload(body: unknown) {
  const input = z
    .object({
      recipient: z
        .string()
        .trim()
        .min(1)
        .max(10000)
        .refine(
          (value) => {
            const tokens = parseRecipients(value);
            return tokens.length === 1 && tokens[0].kind === "email";
          },
          () => ({ message: serverMessage("tasks.testEmailSingleRecipient") }),
        ),
      subject: z.string().max(500000),
      html: z.string().min(1).max(500000),
      row: rowSchema.default({}),
      mapping: mappingSchema.default({}),
    })
    .strict()
    .parse(body);
  const content = { subject: input.subject, html: input.html };
  const row = Object.fromEntries(
    fieldsIn(content).map((field) => {
      const column = input.mapping[field] || field;
      const value = Object.hasOwn(input.row, column)
        ? input.row[column]
        : undefined;
      if (value === undefined || value === null || String(value).trim() === "")
        throw Error(
          serverMessage("tasks.missingFieldValue0", { value0: field }),
        );
      return [field, value];
    }),
  );
  if (!input.html.trim())
    throw Error(serverMessage("tasks.testEmailBodyRequired"));
  return emailSchema.parse({
    ...renderPayload(content, row),
    to: normalizeRecipients(input.recipient),
    cc: "",
    bcc: "",
  });
}
