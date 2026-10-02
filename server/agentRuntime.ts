import { z } from "zod";
import type { AgentProgress } from "./agentTypes.js";
import type { AgentTools } from "./agentTools.js";
import { serverMessage } from "./i18n.js";

export const MAX_AGENT_ROUNDS = 16;
export const MAX_AGENT_CALLS = 48;
interface Call {
  id: string;
  name: string;
  arguments: unknown;
}
export async function runAgentTools(
  protocol: string,
  body: any,
  tools: AgentTools,
  submitSchema: object,
  request: (body: any) => Promise<any>,
  emit?: (event: AgentProgress) => void,
  signal?: AbortSignal,
) {
  const definitions = [
    ...tools.definitions,
    {
      name: "submit_draft",
      description:
        "Finish with a message and an editable draft suggestion. Does not execute anything. Use an empty payload when no suggestion is needed.",
      parameters: submitSchema,
    },
  ];
  if (protocol === "anthropic") {
    body.tools = definitions.map(({ name, description, parameters }) => ({
      name,
      description,
      input_schema: parameters,
    }));
    body.tool_choice = { type: "auto" };
  } else {
    body.tools = definitions.map(({ name, description, parameters }) =>
      protocol === "openai-chat"
        ? {
            type: "function",
            function: { name, description, parameters, strict: false },
          }
        : { type: "function", name, description, parameters, strict: false },
    );
    body.tool_choice = "auto";
    if (protocol === "openai-chat") delete body.response_format;
    else delete body.text;
  }
  if (protocol === "openai-responses" && typeof body.input === "string")
    body.input = [{ role: "user", content: body.input }];
  let count = 0;
  let totalBytes = 0;
  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (signal?.aborted) throw signal.reason ?? Error("Agent cancelled.");
    if (round) emit?.({ type: "progress", stage: "model" });
    if (Buffer.byteLength(JSON.stringify(body)) > 8 * 1024 * 1024)
      throw Error(serverMessage("agentTools.limit"));
    const data = await request(body);
    // Never execute arguments from incomplete or refused generations.
    if (
      ["incomplete", "failed", "cancelled", "queued", "in_progress"].includes(
        data.status,
      ) ||
      data.stop_reason === "max_tokens" ||
      ["length", "content_filter"].includes(data.choices?.[0]?.finish_reason)
    )
      return data;
    const calls: Call[] =
      protocol === "anthropic"
        ? (data.content ?? [])
            .filter((block: any) => block.type === "tool_use")
            .map((block: any) => ({
              id: block.id,
              name: block.name,
              arguments: block.input,
            }))
        : protocol === "openai-chat"
          ? (data.choices?.[0]?.message?.tool_calls ?? []).map((call: any) => ({
              id: call.id,
              name: call.function?.name,
              arguments: call.function?.arguments,
            }))
          : (data.output ?? [])
              .filter((item: any) => item.type === "function_call")
              .map((item: any) => ({
                id: item.call_id,
                name: item.name,
                arguments: item.arguments,
              }));
    if (!calls.length) return data;
    if (
      data.choices?.[0]?.message?.refusal ||
      data.stop_reason === "refusal" ||
      (protocol === "anthropic"
        ? (data.content ?? [])
        : (data.output ?? []).flatMap((item: any) => item.content ?? [])
      ).some((block: any) => block.type === "refusal")
    )
      return data;
    if (count + calls.length > MAX_AGENT_CALLS)
      throw Error(serverMessage("agentTools.limit"));
    const business = calls.filter((call) => call.name !== "submit_draft");
    const results: { call: Call; value: unknown; error: boolean }[] = [];
    const ids = new Set<string>();
    for (const call of business) {
      if (
        !call.id ||
        typeof call.id !== "string" ||
        typeof call.name !== "string" ||
        ids.has(call.id)
      )
        throw Error("Invalid provider tool call ID.");
      ids.add(call.id);
      count++;
      emit?.({
        type: "tool",
        tool: { callId: call.id, name: call.name, status: "running" },
      });
      let value: unknown,
        error = false;
      try {
        const args =
          typeof call.arguments === "string"
            ? JSON.parse(call.arguments)
            : call.arguments;
        value = { ok: true, result: tools.execute(call.name, args) };
        if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
          throw Error(
            "Tool result is too large. Reduce limit or read a smaller range.",
          );
      } catch (cause) {
        if (signal?.aborted) throw cause;
        error = true;
        const message =
          cause instanceof z.ZodError
            ? cause.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")
            : cause instanceof SyntaxError
              ? "Invalid tool argument JSON."
              : cause instanceof Error &&
                  !/SQLITE|constraint|https?:\/\//i.test(cause.message)
                ? cause.message
                : serverMessage("agentTools.invalidTool");
        value = { ok: false, error: message.slice(0, 4000) };
      }
      const encoded = JSON.stringify(value);
      totalBytes += Buffer.byteLength(encoded);
      if (totalBytes > 8 * 1024 * 1024)
        throw Error(serverMessage("agentTools.limit"));
      emit?.({
        type: "tool",
        tool: {
          callId: call.id,
          name: call.name,
          status: error ? "error" : "complete",
          summary: error
            ? (value as { error: string }).error
            : serverMessage("agentTools.completed"),
        },
      });
      results.push({ call, value, error });
    }
    const submission = calls.filter((call) => call.name === "submit_draft");
    if (submission.length > 1) throw Error("Multiple final draft submissions.");
    if (submission.length && !business.length) {
      const call = submission[0];
      const input =
        typeof call.arguments === "string"
          ? JSON.parse(call.arguments)
          : call.arguments;
      // Normalize all providers to the existing final-draft parser.
      return protocol === "anthropic"
        ? {
            ...data,
            content: [{ type: "tool_use", name: "submit_draft", input }],
          }
        : protocol === "openai-chat"
          ? {
              ...data,
              choices: [
                {
                  message: { content: JSON.stringify(input) },
                  finish_reason: "stop",
                },
              ],
            }
          : { ...data, output: [], output_text: JSON.stringify(input) };
    }
    // A final draft in the same batch is premature: the model has not read its
    // business-tool results yet. Return a result for it and ask it to finish again.
    for (const call of submission)
      results.push({
        call,
        value: {
          ok: false,
          error:
            "Read the other tool results and call submit_draft again after them.",
        },
        error: true,
      });
    if (protocol === "anthropic") {
      body.messages.push({ role: "assistant", content: data.content });
      body.messages.push({
        role: "user",
        content: results.map(({ call, value, error }) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(value),
          is_error: error,
        })),
      });
    } else if (protocol === "openai-chat") {
      body.messages.push({ role: "assistant", ...data.choices[0].message });
      for (const { call, value } of results)
        body.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(value),
        });
    } else {
      body.input.push(...data.output);
      for (const { call, value } of results)
        body.input.push({
          type: "function_call_output",
          call_id: call.id,
          output: JSON.stringify(value),
        });
    }
  }
  throw Error(serverMessage("agentTools.limit"));
}
