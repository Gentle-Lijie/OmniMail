import { z } from "zod";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export const attachmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      name: z.string().min(1).max(200),
      size: z.number().int().min(1).max(5242880),
      text: z.string().trim().min(1).max(100000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      name: z.string().min(1).max(200),
      size: z.number().int().min(1).max(3145728),
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      data: z
        .string()
        .min(4)
        .max(4194304)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
]);
export type AgentAttachment = z.infer<typeof attachmentSchema>;

function imageType(buffer: Buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
    return "image/jpeg";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export function validateAttachments(value: unknown) {
  const attachments = z
    .array(attachmentSchema)
    .max(5)
    .parse(value ?? []);
  let imageBytes = 0,
    textLength = 0,
    totalBytes = 0;
  for (const attachment of attachments) {
    totalBytes += attachment.size;
    if (attachment.kind === "text") textLength += attachment.text.length;
    else {
      const buffer = Buffer.from(attachment.data, "base64");
      if (
        buffer.toString("base64") !== attachment.data ||
        imageType(buffer) !== attachment.mediaType ||
        buffer.length !== attachment.size
      )
        throw Error("Invalid image attachment");
      imageBytes += buffer.length;
    }
  }
  if (imageBytes > 3145728 || totalBytes > 10485760 || textLength > 200000)
    throw Error(
      "Attachment context exceeds limits: 10 MB total, 3 MB images, 200,000 text characters",
    );
  return attachments;
}

function checkArchive(buffer: Buffer) {
  let end = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 65557);
    offset--
  ) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw Error("Invalid document archive");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16),
    expanded = 0;
  if (count > 2000) throw Error("Document archive contains too many entries");
  for (let index = 0; index < count; index++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    )
      throw Error("Invalid document archive");
    expanded += buffer.readUInt32LE(offset + 24);
    if (expanded > 20971520) throw Error("Expanded document exceeds 20 MB");
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}

export async function readAgentAttachment(
  filename: string,
  buffer: Buffer,
): Promise<AgentAttachment> {
  if (!buffer.length || buffer.length > 5242880)
    throw Error("Each attachment must be non-empty and at most 5 MB");
  const name =
    filename
      .split(/[\\/]/)
      .pop()!
      .replace(/[\x00-\x1f]/g, "")
      .slice(0, 200) || "attachment";
  const extension = name.split(".").pop()?.toLowerCase();
  const mediaType = imageType(buffer);
  if (["png", "jpg", "jpeg", "webp"].includes(extension || "")) {
    if (!mediaType || buffer.length > 3145728)
      throw Error("Invalid image or image exceeds 3 MB");
    return {
      kind: "image",
      name,
      size: buffer.length,
      mediaType,
      data: buffer.toString("base64"),
    };
  }
  let text: string;
  if (extension === "pdf") {
    if (buffer.toString("ascii", 0, 5) !== "%PDF-") throw Error("Invalid PDF");
    const parser = new PDFParse({ data: buffer, isEvalSupported: false });
    try {
      const info = await parser.getInfo();
      if (info.total > 50) throw Error("PDF must contain at most 50 pages");
      text = (await parser.getText()).pages
        .map((page) => page.text)
        .join("\n\n");
    } finally {
      await parser.destroy();
    }
  } else if (extension === "docx") {
    checkArchive(buffer);
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (["xlsx", "xls"].includes(extension || "")) {
    if (extension === "xlsx") checkArchive(buffer);
    const workbook = XLSX.read(buffer, { type: "buffer", sheetRows: 501 });
    if (workbook.SheetNames.length > 10)
      throw Error("Spreadsheet must contain at most 10 sheets");
    text = workbook.SheetNames.map((sheet) => {
      const range = XLSX.utils.decode_range(
        workbook.Sheets[sheet]["!ref"] || "A1",
      );
      if (range.e.r >= 500 || range.e.c >= 100)
        throw Error(
          "Spreadsheet context is limited to 500 rows and 100 columns per sheet",
        );
      return `${sheet}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheet])}`;
    }).join("\n\n");
  } else if (
    ["txt", "md", "csv", "tsv", "json", "html", "htm", "xml", "log"].includes(
      extension || "",
    )
  ) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw Error("Text attachments must use UTF-8 encoding");
    }
    if (text.includes("\0"))
      throw Error("Binary files are not supported as text attachments");
  } else
    throw Error(
      "Unsupported file. Use text, PDF, DOCX, spreadsheets, PNG, JPEG or WebP",
    );
  text = text.trim();
  if (!text) throw Error("No readable text found. Scanned PDFs need OCR first");
  if (text.length > 100000)
    throw Error(
      "Extracted text exceeds 100,000 characters; upload a smaller document",
    );
  return { kind: "text", name, size: buffer.length, text };
}
