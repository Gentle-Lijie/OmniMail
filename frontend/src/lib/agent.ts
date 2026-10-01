import { message } from "./i18n";
export interface AgentAttachment {
  kind: "text" | "image";
  name: string;
  size: number;
  text?: string;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
  data?: string;
}
export interface AgentProgress {
  type: "progress" | "thinking";
  stage?: "context" | "model" | "drafting" | "validating";
  text?: string;
}
export class AgentStreamError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export async function readAgentResponse<Result>(
  response: Response,
  onProgress: (event: AgentProgress) => void,
): Promise<Result> {
  if (!response.body)
    throw new AgentStreamError(message("agent.emptyResponse"));
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    size = 0,
    result: Result | undefined;
  const consume = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new AgentStreamError(message("agent.invalidStream"));
    }
    if (event.type === "error")
      throw new AgentStreamError(
        event.error || message("agent.requestFailed"),
        event.code,
      );
    if (event.type === "result") result = event.result;
    else if (["progress", "thinking"].includes(event.type)) onProgress(event);
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2000000)
        throw new AgentStreamError(message("agent.responseTooLarge"));
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (result === undefined)
      throw new AgentStreamError(message("agent.incompleteStream"));
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function attachmentIssue(
  current: AgentAttachment[],
  files: { name: string; size: number }[],
): "count" | "size" | "type" | "context" | undefined {
  if (current.length + files.length > 5) return "count";
  if (files.some((file) => !file.size || file.size > 5242880)) return "size";
  if (
    files.some(
      (file) =>
        !/\.(txt|md|csv|tsv|json|html?|xml|log|pdf|docx|xlsx?|png|jpe?g|webp)$/i.test(
          file.name,
        ),
    )
  )
    return "type";
  const images =
    current
      .filter((file) => file.kind === "image")
      .reduce((total, file) => total + file.size, 0) +
    files
      .filter((file) => /\.(png|jpe?g|webp)$/i.test(file.name))
      .reduce((total, file) => total + file.size, 0);
  if (
    images > 3145728 ||
    [...current, ...files].reduce((total, file) => total + file.size, 0) >
      10485760
  )
    return "context";
}
