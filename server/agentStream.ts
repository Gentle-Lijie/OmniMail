export interface AgentProgress {
  type: "progress" | "thinking";
  stage?: "context" | "model" | "drafting" | "validating";
  text?: string;
}

export async function readProviderStream(
  response: Response,
  protocol: string,
  emit: (event: AgentProgress) => void,
): Promise<any> {
  if (!response.body) throw Error("Provider returned an empty stream");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    size = 0,
    text = "",
    reasoningLength = 0,
    complete = false;
  let data: any =
    protocol === "openai-chat"
      ? { choices: [{ message: { content: "" }, finish_reason: null }] }
      : protocol === "anthropic"
        ? { content: [] }
        : { output: [] };
  const toolArguments = new Map<number, string>();
  const thinking = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const chunk = value.slice(0, Math.max(0, 20000 - reasoningLength));
    reasoningLength += chunk.length;
    if (chunk) emit({ type: "thinking", text: chunk });
  };
  const consume = (frame: string) => {
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload || payload === "[DONE]") return;
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      throw Error("Provider returned invalid stream data");
    }
    if (event.error || event.type === "error")
      throw Error("Provider stream failed");
    if (protocol === "openai-chat") {
      const choice =
        event.choices?.find((item: any) => item.index === 0) ??
        event.choices?.[0];
      if (!choice) return;
      thinking(choice.delta?.reasoning_content ?? choice.delta?.reasoning);
      if (typeof choice.delta?.content === "string") {
        text += choice.delta.content;
        emit({ type: "progress", stage: "drafting" });
      }
      if (choice.delta?.refusal) data.choices[0].message.refusal = true;
      if (choice.finish_reason) {
        complete = true;
        data.choices[0].finish_reason = choice.finish_reason;
      }
      data.choices[0].message.content = text;
    } else if (protocol === "anthropic") {
      if (event.type === "message_start")
        data = { ...event.message, content: [] };
      if (event.type === "content_block_start")
        data.content[event.index] = { ...event.content_block };
      if (event.type === "content_block_delta") {
        const block = data.content[event.index];
        if (event.delta?.type === "thinking_delta")
          thinking(event.delta.thinking);
        if (event.delta?.type === "text_delta" && block) {
          block.text = (block.text ?? "") + event.delta.text;
          emit({ type: "progress", stage: "drafting" });
        }
        if (event.delta?.type === "input_json_delta") {
          toolArguments.set(
            event.index,
            (toolArguments.get(event.index) ?? "") + event.delta.partial_json,
          );
          emit({ type: "progress", stage: "drafting" });
        }
      }
      if (event.type === "message_delta") Object.assign(data, event.delta);
      if (event.type === "message_stop") complete = true;
    } else {
      if (event.type === "response.reasoning_summary_text.delta")
        thinking(event.delta);
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        emit({ type: "progress", stage: "drafting" });
      }
      if (
        [
          "response.completed",
          "response.incomplete",
          "response.failed",
        ].includes(event.type)
      ) {
        data = event.response;
        complete = true;
      }
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2000000) throw Error("Provider response exceeds 2 MB");
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!complete) throw Error("Provider stream ended before completion");
    for (const [index, value] of toolArguments)
      data.content[index].input = JSON.parse(value);
    if (protocol === "openai-responses" && text && !data.output?.length)
      data.output_text = text;
    return data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
