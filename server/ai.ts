import { serverMessage } from "./i18n.js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { id, type Store } from "./store.js";
import {
  validateAttachments,
  type AgentAttachment,
} from "./agentAttachments.js";
import { readProviderStream } from "./agentStream.js";
import { type AgentProgress, draftFields } from "./agentTypes.js";
import { createAgentTools, type AgentTools } from "./agentTools.js";
import { runAgentTools } from "./agentRuntime.js";
import { rowSchema, mappingSchema } from "./draftValidation.js";

interface AgentOptions {
  onProgress?: (event: AgentProgress) => void;
  signal?: AbortSignal;
  principal?: string;
}

export const protocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "anthropic",
]);
export const providerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  protocol: protocolSchema,
  baseUrl: z.string().url(),
  model: z.string().trim().max(200).default(""),
  apiKey: z.string().trim().max(10000).optional(),
  headers: z.record(z.string().max(10000)).optional(),
  outputMode: z.enum(["auto", "json", "prompt"]).default("auto"),
});
type ProviderInput = z.infer<typeof providerSchema>;
type ResolvedProvider = Omit<ProviderInput, "apiKey" | "headers"> & {
  id?: string;
  apiKey: string;
  headers: Record<string, string>;
};
const previewSchema = providerSchema.extend({
  id: z.string().optional(),
  name: z.string().trim().max(100).default("Provider"),
});
const fields = draftFields;
const resultSchema = z
  .object({
    message: z.string().max(20000),
    kind: z.enum(["email", "event"]),
    payload: z.record(z.string().max(500000)),
    templateId: z.string().nullable().optional(),
    mapping: z.record(z.string()).nullable().optional(),
  })
  .strict();
const draftJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    kind: { type: "string", enum: ["email", "event"] },
    payload: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        [...new Set([...fields.email, ...fields.event])].map((field) => [
          field,
          { type: ["string", "null"] },
        ]),
      ),
      required: [...new Set([...fields.email, ...fields.event])],
    },
    templateId: { type: ["string", "null"] },
    mapping: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: { field: { type: "string" }, column: { type: "string" } },
        required: ["field", "column"],
      },
    },
  },
  required: ["message", "kind", "payload", "templateId", "mapping"],
};
const toolDraftSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    kind: { type: "string", enum: ["email", "event"] },
    payload: {
      type: "object",
      properties: Object.fromEntries(
        [...new Set([...fields.email, ...fields.event])].map((field) => [
          field,
          { type: "string" },
        ]),
      ),
    },
    templateId: { type: "string" },
    mapping: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["message", "kind", "payload"],
};

export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public upstreamStatus?: number,
  ) {
    super(message);
  }
}
export function safeURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(serverMessage("ai.useHTTPSHTTPAllowedOnlyForLocalhost"));
  if (url.username || url.password || url.hash)
    throw new Error(serverMessage("ai.invalidEndpointURL"));
  return url.toString().replace(/\/$/, "");
}
export function providerBaseURL(
  value: string,
  protocol: ProviderInput["protocol"],
) {
  const url = new URL(safeURL(value));
  if (url.search)
    throw new ProviderError(
      "invalid_base_url",
      serverMessage("ai.baseURLMustNotContainQueryParameters"),
    );
  let path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|responses|messages|models)$/, "");
  if (!path || (protocol === "anthropic" && !path.endsWith("/v1")))
    path += "/v1";
  url.pathname = path;
  return url.toString().replace(/\/$/, "");
}

export function createAI(store: Store, fetcher: typeof fetch = fetch) {
  const get = (providerId: string): any => {
    const row = store.db
      .prepare("SELECT value FROM providers WHERE id=?")
      .get(providerId) as { value: string } | undefined;
    if (!row)
      throw new ProviderError(
        "provider_missing",
        serverMessage("ai.selectAnAIProviderInSettingsFirst"),
      );
    return JSON.parse(row.value);
  };
  const list = () =>
    (
      store.db.prepare("SELECT value FROM providers ORDER BY rowid").all() as {
        value: string;
      }[]
    ).map((row) => {
      const { apiKey, headers, ...provider } = JSON.parse(row.value);
      return {
        ...provider,
        baseUrl: providerBaseURL(provider.baseUrl, provider.protocol),
        outputMode: provider.outputMode || "auto",
        hasApiKey: !!apiKey,
        hasHeaders:
          !!headers &&
          Object.keys(JSON.parse(store.decrypt(headers))).length > 0,
      };
    });
  const defaultProviderId = (): string => {
    const providers = list();
    const current = store.get("defaultProviderId", "");
    return providers.some((provider) => provider.id === current)
      ? current
      : providers.length === 1
        ? providers[0].id
        : "";
  };
  const resolve = (body: unknown): ResolvedProvider => {
    const input = previewSchema.parse(body);
    const previous = input.id ? get(input.id) : undefined;
    const baseUrl = providerBaseURL(input.baseUrl, input.protocol);
    if (
      previous &&
      !input.apiKey &&
      new URL(previous.baseUrl).origin !== new URL(baseUrl).origin
    )
      throw new ProviderError(
        "key_required",
        serverMessage("ai.enterAnAPIKeyWhenChangingTheProviderHost"),
      );
    const apiKey =
      input.apiKey || (previous?.apiKey ? store.decrypt(previous.apiKey) : "");
    if (!apiKey)
      throw new ProviderError(
        "key_required",
        serverMessage("ai.enterAnAPIKeyToDiscoverModels"),
      );
    const customHeaders =
      input.headers ??
      (previous?.headers ? JSON.parse(store.decrypt(previous.headers)) : {});
    for (const [name, value] of Object.entries(customHeaders)) {
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n]/.test(String(value)))
        throw new ProviderError(
          "invalid_headers",
          serverMessage("ai.invalidCustomHeaderNameOrValue"),
        );
      if (
        [
          "host",
          "content-length",
          "connection",
          "transfer-encoding",
          "cookie",
        ].includes(name.toLowerCase())
      )
        throw new ProviderError(
          "invalid_headers",
          serverMessage("ai.thisTransportHeaderCannotBeCustomized"),
        );
    }
    return { ...input, baseUrl, apiKey, headers: customHeaders };
  };
  const saved = (providerId: string) => {
    const provider = get(providerId);
    return resolve({
      ...provider,
      apiKey: store.decrypt(provider.apiKey),
      headers: provider.headers
        ? JSON.parse(store.decrypt(provider.headers))
        : {},
    });
  };
  const save = (body: unknown, providerId = id()) => {
    const parsed = providerSchema
      .extend({ makeDefault: z.boolean().optional() })
      .parse(body);
    const exists = store.db
      .prepare("SELECT id FROM providers WHERE id=?")
      .get(providerId);
    const provider = resolve({
      ...parsed,
      ...(exists ? { id: providerId } : {}),
    });
    const stored = {
      ...provider,
      id: providerId,
      apiKey: store.encrypt(provider.apiKey),
      headers: store.encrypt(JSON.stringify(provider.headers)),
    };
    const previousDefault = defaultProviderId();
    store.db.transaction(() => {
      store.db
        .prepare("INSERT OR REPLACE INTO providers VALUES (?,?)")
        .run(providerId, JSON.stringify(stored));
      if (parsed.makeDefault || !previousDefault)
        store.set("defaultProviderId", providerId);
      else if (!store.get("defaultProviderId"))
        store.set("defaultProviderId", previousDefault);
      store.audit("provider.saved");
    })();
    return list().find((provider) => provider.id === providerId);
  };
  const remove = (providerId: string) => {
    get(providerId);
    const current = defaultProviderId();
    store.db.transaction(() => {
      store.db.prepare("DELETE FROM providers WHERE id=?").run(providerId);
      if (current === providerId)
        store.set(
          "defaultProviderId",
          list().find((provider) => provider.model)?.id || "",
        );
      store.audit("provider.removed");
    })();
  };
  const requestHeaders = (provider: ResolvedProvider) => {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    if (provider.protocol === "anthropic") {
      headers.set("x-api-key", provider.apiKey);
      headers.set("anthropic-version", "2023-06-01");
    } else headers.set("Authorization", `Bearer ${provider.apiKey}`);
    for (const [name, value] of Object.entries(provider.headers))
      headers.set(name, value);
    return headers;
  };
  const readResponse = async (response: Response) => {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2000000) {
          await reader.cancel();
          throw new ProviderError(
            "response_too_large",
            serverMessage("ai.providerResponseExceeds2MB"),
          );
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      reader.releaseLock();
    }
  };
  const request = async (
    provider: ResolvedProvider,
    url: string,
    body: unknown,
    signal = AbortSignal.timeout(45000),
    onProgress?: AgentOptions["onProgress"],
  ): Promise<any> => {
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: requestHeaders(provider),
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (
        response.ok &&
        onProgress &&
        response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        try {
          return await readProviderStream(
            response,
            provider.protocol,
            onProgress,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new ProviderError(
            "invalid_response",
            serverMessage(
              "ai.providerStreamFailedOrEndedBeforeCompletionDraftUnchanged",
            ),
          );
        }
      }
      const text = await readResponse(response);
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok)
          throw new ProviderError(
            "invalid_response",
            serverMessage("ai.providerReturnedInvalidJSON"),
          );
      }
      if (!response.ok) {
        const upstreamCode = data?.error?.code ?? data?.error?.type;
        const safeCode =
          typeof upstreamCode === "string" &&
          /^[\w.-]{1,80}$/.test(upstreamCode)
            ? ` (${upstreamCode})`
            : "";
        const code = [401, 403].includes(response.status)
          ? "provider_auth"
          : [404, 405, 501].includes(response.status)
            ? "endpoint_unsupported"
            : response.status === 429
              ? "provider_rate_limit"
              : "provider_http";
        throw new ProviderError(
          code,
          serverMessage("ai.providerHTTPValue0Value1", {
            value0: response.status,
            value1: safeCode,
          }),
          response.status,
        );
      }
      if (!data || typeof data !== "object")
        throw new ProviderError(
          "invalid_response",
          serverMessage("ai.providerReturnedAnInvalidResponseObject"),
        );
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        signal.aborted ? "provider_timeout" : "provider_connection",
        signal.aborted
          ? serverMessage("ai.providerRequestTimedOut")
          : serverMessage(
              "ai.cannotConnectToProviderCheckEndpointAndCustomHeaders",
            ),
      );
    }
  };
  const discover = async (body: unknown) => {
    const provider = resolve(body);
    const signal = AbortSignal.timeout(20000);
    const options = {
      apiKey: provider.apiKey,
      defaultHeaders: provider.headers,
      maxRetries: 0,
      timeout: 20000,
      fetch: (async (url, init) => {
        const response = await fetcher(url, { ...init, redirect: "error" });
        return new Response(await readResponse(response), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }) as typeof fetch,
    };
    try {
      let page =
        provider.protocol === "anthropic"
          ? await new Anthropic({
              ...options,
              authToken: null,
              baseURL: provider.baseUrl.replace(/\/v1$/, ""),
            }).models.list({}, { signal })
          : await new OpenAI({
              ...options,
              baseURL: provider.baseUrl,
            }).models.list({ signal });
      const models = new Map<string, { id: string; name: string }>();
      const cursors = new Set<string>();
      let hasMore = false;
      for (let count = 0; count < 10; count++) {
        if (!Array.isArray(page.data))
          throw new ProviderError(
            "models_unsupported",
            serverMessage(
              "ai.thisEndpointDoesNotExposeAStandardModelDirectory",
            ),
          );
        for (const model of page.data) {
          if (
            typeof model?.id !== "string" ||
            !model.id ||
            model.id.length > 200
          )
            continue;
          models.set(model.id, {
            id: model.id,
            name:
              "display_name" in model && typeof model.display_name === "string"
                ? model.display_name
                : model.id,
          });
          if (models.size >= 1000) break;
        }
        hasMore = page.hasNextPage();
        if (!hasMore || models.size >= 1000 || count === 9) break;
        const cursor = page.data.at(-1)?.id;
        if (!cursor || cursors.has(cursor)) break;
        cursors.add(cursor);
        page = await page.getNextPage();
      }
      if (!models.size)
        throw new ProviderError(
          "models_empty",
          serverMessage("ai.providerReturnedNoModelsAvailableToThisAPIKey"),
        );
      return {
        models: [...models.values()].sort((first, second) =>
          first.id.localeCompare(second.id),
        ),
        hasMore,
        endpoint: `${provider.baseUrl}/models`,
        source: "api" as const,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (
        error instanceof OpenAI.APIConnectionTimeoutError ||
        error instanceof Anthropic.APIConnectionTimeoutError
      )
        throw new ProviderError(
          "provider_timeout",
          serverMessage("ai.providerRequestTimedOut"),
        );
      if (
        error instanceof OpenAI.APIError ||
        error instanceof Anthropic.APIError
      ) {
        if (error.cause instanceof ProviderError) throw error.cause;
        const status = error.status;
        if (status !== undefined) {
          const code = [401, 403].includes(status)
            ? "provider_auth"
            : [404, 405, 501].includes(status)
              ? "endpoint_unsupported"
              : status === 429
                ? "provider_rate_limit"
                : "provider_http";
          throw new ProviderError(
            code,
            serverMessage("ai.providerHTTPValue0", { value0: status }),
            status,
          );
        }
      }
      throw new ProviderError(
        signal.aborted ? "provider_timeout" : "provider_connection",
        signal.aborted
          ? serverMessage("ai.providerRequestTimedOut")
          : serverMessage(
              "ai.cannotConnectToProviderCheckEndpointAndCustomHeaders",
            ),
      );
    }
  };
  const complete = async (
    provider: ResolvedProvider,
    system: string,
    input: string,
    structured = false,
    maxTokens = 4096,
    options: AgentOptions = {},
    attachments: AgentAttachment[] = [],
    tools?: AgentTools,
  ) => {
    const model = provider.model;
    if (!model)
      throw new ProviderError(
        "model_required",
        serverMessage("ai.chooseAModelBeforeVerifyingDrafting"),
      );
    const enforce = structured && provider.outputMode !== "prompt";
    const strictSchema =
      provider.outputMode === "auto" &&
      new URL(provider.baseUrl).hostname === "api.openai.com";
    let body: any;
    let route: string;
    if (provider.protocol === "anthropic") {
      route = "messages";
      body = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: input }],
      };
      if (enforce && provider.outputMode === "auto")
        Object.assign(body, {
          tools: [
            {
              name: "submit_draft",
              description: serverMessage(
                "ai.returnTheEditableDraftWithoutExecutingAnything",
              ),
              input_schema: toolDraftSchema,
            },
          ],
          tool_choice: { type: "tool", name: "submit_draft" },
        });
    } else if (provider.protocol === "openai-chat") {
      route = "chat/completions";
      body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input },
        ],
        max_completion_tokens: maxTokens,
      };
      if (new URL(provider.baseUrl).hostname !== "api.openai.com") {
        body.max_tokens = maxTokens;
        delete body.max_completion_tokens;
      }
      if (enforce)
        body.response_format = strictSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: "omnimail_draft",
                strict: true,
                schema: draftJsonSchema,
              },
            }
          : { type: "json_object" };
    } else {
      route = "responses";
      body = {
        model,
        instructions: system,
        input,
        max_output_tokens: maxTokens,
        store: false,
      };
      if (enforce)
        body.text = {
          format: strictSchema
            ? {
                type: "json_schema",
                name: "omnimail_draft",
                strict: true,
                schema: draftJsonSchema,
              }
            : { type: "json_object" },
        };
      if (
        options.onProgress &&
        new URL(provider.baseUrl).hostname === "api.openai.com" &&
        /^(o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(model)
      )
        body.reasoning = { summary: "auto" };
    }
    const images = attachments.filter(
      (attachment): attachment is Extract<AgentAttachment, { kind: "image" }> =>
        attachment.kind === "image",
    );
    if (images.length) {
      if (provider.protocol === "anthropic")
        body.messages[0].content = [
          { type: "text", text: input },
          ...images.map((image) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.data,
            },
          })),
        ];
      else if (provider.protocol === "openai-chat")
        body.messages[1].content = [
          { type: "text", text: input },
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
        ];
      else
        body.input = [
          {
            role: "user",
            content: [
              { type: "input_text", text: input },
              ...images.map((image) => ({
                type: "input_image",
                image_url: `data:${image.mediaType};base64,${image.data}`,
              })),
            ],
          },
        ];
    }
    if (options.onProgress) body.stream = true;
    const signal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(tools ? 180000 : 45000),
        ])
      : AbortSignal.timeout(tools ? 180000 : 45000);
    let thoughtSeen = false,
      draftSeen = false;
    const progress = options.onProgress
      ? (event: AgentProgress) => {
          if (event.type === "thinking") thoughtSeen = true;
          if (event.stage === "drafting") draftSeen = true;
          options.onProgress!(event);
        }
      : undefined;
    const send = (body: unknown) =>
      request(
        provider,
        `${provider.baseUrl}/${route}`,
        body,
        AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        progress,
      );
    let data: any;
    try {
      data = tools
        ? await runAgentTools(
            provider.protocol,
            body,
            tools,
            toolDraftSchema,
            send,
            progress,
            signal,
          )
        : await send(body);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        signal.aborted ? "provider_timeout" : "agent_tools",
        signal.aborted
          ? serverMessage("ai.providerRequestTimedOut")
          : error instanceof Error
            ? error.message
            : serverMessage("agentTools.invalidTool"),
      );
    }
    if (progress) {
      const summary =
        provider.protocol === "openai-chat"
          ? data.choices?.[0]?.message?.reasoning_content
          : provider.protocol === "anthropic"
            ? (data.content ?? [])
                .filter((block: any) => block?.type === "thinking")
                .map((block: any) => block.thinking)
                .join("\n")
            : (data.output ?? [])
                .filter((item: any) => item?.type === "reasoning")
                .flatMap((item: any) => item.summary ?? [])
                .map((item: any) => item.text ?? "")
                .join("\n");
      if (!thoughtSeen && typeof summary === "string" && summary.trim())
        progress({ type: "thinking", text: summary.slice(0, 20000) });
      if (!draftSeen) progress({ type: "progress", stage: "drafting" });
    }
    if (
      ["incomplete", "failed", "cancelled", "queued", "in_progress"].includes(
        data.status,
      ) ||
      data.stop_reason === "max_tokens" ||
      ["length", "content_filter"].includes(data.choices?.[0]?.finish_reason)
    )
      throw new ProviderError(
        "output_incomplete",
        serverMessage("ai.providerOutputIsIncompleteDraftUnchanged"),
      );
    const blocks =
      provider.protocol === "anthropic"
        ? data.content
        : (data.output ?? []).flatMap((item: any) => item.content ?? []);
    if (
      data.choices?.[0]?.message?.refusal ||
      blocks?.some((block: any) => block.type === "refusal") ||
      data.stop_reason === "refusal"
    )
      throw new ProviderError(
        "output_refused",
        serverMessage("ai.providerRefusedTheDraftingRequest"),
      );
    if (provider.protocol === "anthropic" && (enforce || tools)) {
      const tool = data.content?.find(
        (block: any) =>
          block.type === "tool_use" && block.name === "submit_draft",
      );
      if (tool) return JSON.stringify(tool.input);
    }
    const text =
      provider.protocol === "openai-chat"
        ? data.choices?.[0]?.message?.content
        : provider.protocol === "anthropic"
          ? (data.content ?? [])
              .filter((block: any) => block.type === "text")
              .map((block: any) => block.text)
              .join("\n")
          : (data.output_text ??
            (blocks ?? [])
              .filter((block: any) => block.type === "output_text")
              .map((block: any) => block.text)
              .join("\n"));
    if (typeof text !== "string" || !text.trim())
      throw new ProviderError(
        "output_empty",
        serverMessage("ai.providerReturnedNoUsableTextCheckAPITypeAndModel"),
      );
    return text;
  };
  const parseDraft = (
    text: string,
    current: {
      kind: "email" | "event";
      payload: Record<string, string>;
      templateId?: string;
    },
  ) => {
    let raw: any;
    try {
      raw = JSON.parse(
        text
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, ""),
      );
    } catch {
      throw new ProviderError(
        "output_invalid",
        serverMessage(
          "ai.providerCannotReturnAStructuredDraftWithThisConfigurationTryADifferentOutputMode",
        ),
      );
    }
    if (raw?.payload && typeof raw.payload === "object")
      raw.payload = Object.fromEntries(
        Object.entries(raw.payload).filter(([, value]) => value !== null),
      );
    if (Array.isArray(raw?.mapping)) {
      const mapping = z
        .array(z.object({ field: z.string(), column: z.string() }).strict())
        .safeParse(raw.mapping);
      if (!mapping.success)
        throw new ProviderError(
          "output_invalid",
          serverMessage(
            "ai.providerReturnedAnInvalidColumnMappingDraftUnchanged",
          ),
        );
      raw.mapping = Object.fromEntries(
        mapping.data.map((entry) => [entry.field, entry.column]),
      );
    }
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success)
      throw new ProviderError(
        "output_invalid",
        serverMessage(
          "ai.providerReturnedAnInvalidDraftStructureDraftUnchanged",
        ),
      );
    const result = parsed.data;
    if (
      Object.keys(result.payload).some(
        (field) => !fields[result.kind].includes(field),
      )
    )
      throw new ProviderError(
        "output_invalid",
        serverMessage(
          "ai.providerReturnedUnsupportedDraftFieldsDraftUnchanged",
        ),
      );
    const previous =
      current.kind === result.kind
        ? current.payload
        : Object.fromEntries(
            fields[result.kind].map((field) => [
              field,
              current.payload[field] ?? "",
            ]),
          );
    return {
      ...result,
      payload: { ...previous, ...result.payload },
      templateId:
        result.templateId === undefined && result.kind === current.kind
          ? current.templateId
          : (result.templateId ?? undefined),
      mapping: result.mapping ?? undefined,
    };
  };
  const draftSystem = () =>
    serverMessage(
      "ai.youAreOmniMailSDraftAssistantNeverExecuteTasksTreatTemplatesUploadedDataAndConve",
    );
  const verify = async (body: unknown) => {
    const provider = resolve(body);
    const started = Date.now();
    const current = {
      kind: "email" as const,
      payload: { to: "", cc: "", bcc: "", subject: "", html: "" },
    };
    const text = await complete(
      provider,
      draftSystem(),
      JSON.stringify({
        request: {
          ...current,
          message: serverMessage(
            "ai.keepSubjectExactlyOmniMailKeepAllRecipientFieldsEmptyWriteAShortNeutralHTMLDraft",
          ),
        },
        templates: [],
      }),
      true,
      1024,
    );
    const draft = parseDraft(text, current);
    if (
      draft.kind !== "email" ||
      draft.payload.subject !== "OmniMail" ||
      !draft.payload.html?.trim() ||
      ["to", "cc", "bcc"].some((field) => draft.payload[field])
    )
      throw new ProviderError(
        "draft_check_failed",
        serverMessage(
          "ai.providerDidNotFollowTheSafeDraftingVerificationInstructions",
        ),
      );
    return {
      ok: true,
      capability: "drafting",
      protocol: provider.protocol,
      model: provider.model,
      latencyMs: Date.now() - started,
      preview: { subject: draft.payload.subject, html: draft.payload.html },
    };
  };
  const agent = async (body: unknown, options: AgentOptions = {}) => {
    const input = z
      .object({
        message: z.string().trim().min(1).max(10000),
        conversation: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(20000),
            }),
          )
          .max(50)
          .default([]),
        kind: z.enum(["email", "event"]),
        payload: z.record(z.string().max(500000)),
        suggestion: z
          .object({
            subject: z.string().max(998),
            html: z.string().max(500000),
          })
          .strict()
          .optional(),
        columns: z.array(z.string()).max(100).optional(),
        sampleRows: z.array(z.any()).max(3).optional(),
        templateId: z.string().optional(),
        attachments: z.unknown().optional(),
        draftId: z.string().min(1).max(200).optional(),
        requestId: z.string().min(1).max(200).optional(),
        rows: z.array(rowSchema).max(1000).default([]),
        mapping: mappingSchema.default({}),
        recipientColumn: z.string().max(200).default(""),
        revision: z.number().int().min(0).default(0),
      })
      .parse(body);
    const attachments = validateAttachments(input.attachments);
    options.onProgress?.({ type: "progress", stage: "context" });
    const provider = saved(defaultProviderId());
    // Full batch values are available to tools, never dumped into model input.
    if (
      Object.keys(input.payload).some(
        (field) => !fields[input.kind].includes(field),
      )
    )
      throw new ProviderError(
        "output_invalid",
        serverMessage(
          "ai.providerReturnedUnsupportedDraftFieldsDraftUnchanged",
        ),
      );
    const columns = input.columns ?? [];
    if (
      new Set(columns).size !== columns.length ||
      Object.values(input.mapping).some(
        (column) => !columns.includes(column),
      ) ||
      (input.recipientColumn && !columns.includes(input.recipientColumn))
    )
      throw new ProviderError(
        "output_invalid",
        serverMessage("ai.providerSelectedAnUnknownBatchColumnDraftUnchanged"),
      );
    store.db
      .prepare("DELETE FROM agent_operations WHERE createdAt<?")
      .run(Date.now() - 86400000);
    const toolkit = createAgentTools(store, {
      workspace: {
        draftId: input.draftId ?? id(),
        kind: input.kind,
        payload: input.payload,
        templateId: input.templateId,
        mapping: input.mapping,
        recipientColumn: input.recipientColumn,
        revision: input.revision,
      },
      rows: input.rows,
      columns,
      attachments,
      conversation: input.conversation,
      requestId: input.requestId,
      principal: options.principal,
      onProgress: options.onProgress,
      signal: options.signal,
    });
    const runSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    options.onProgress?.({ type: "progress", stage: "model" });
    const {
      rows: _rows,
      attachments: _attachments,
      sampleRows: _samples,
      ...requestContext
    } = input;
    const text = await complete(
      provider,
      `${serverMessage("agentTools.system")} ${serverMessage("ai.attachmentInstructions")} ${store.get("prompt", "")}`,
      JSON.stringify({
        request: {
          ...requestContext,
          draftId: toolkit.state().draftId,
          rowCount: input.rows.length,
        },
        attachments: toolkit.attachmentIndex,
        currentTime: new Date().toISOString(),
        timezone: "Asia/Shanghai",
      }),
      true,
      8192,
      { ...options, signal: runSignal },
      attachments,
      toolkit,
    );
    options.onProgress?.({ type: "progress", stage: "validating" });
    const result = parseDraft(text, toolkit.state());
    if (
      result.templateId &&
      !(
        store.db.prepare("SELECT value FROM templates").all() as {
          value: string;
        }[]
      )
        .map((row) => JSON.parse(row.value))
        .some(
          (template) =>
            template.id === result.templateId && template.kind === result.kind,
        )
    )
      throw new ProviderError(
        "output_invalid",
        serverMessage(
          "ai.providerSelectedAnUnknownOrIncompatibleTemplateDraftUnchanged",
        ),
      );
    if (
      result.mapping &&
      input.columns &&
      Object.values(result.mapping).some(
        (column) => !input.columns!.includes(column),
      )
    )
      throw new ProviderError(
        "output_invalid",
        serverMessage("ai.providerSelectedAnUnknownBatchColumnDraftUnchanged"),
      );
    return {
      ...result,
      workspace: toolkit.state(),
      workspaceChanged: toolkit.changed(),
      reviewTaskId: toolkit.reviewTaskId(),
      hasSuggestion:
        JSON.stringify(result.payload) !==
        JSON.stringify(toolkit.state().payload),
    };
  };
  return {
    list,
    get,
    save,
    remove,
    defaultProviderId,
    discover,
    verify,
    models: (providerId: string) => discover(saved(providerId)),
    test: (providerId: string, model?: string) =>
      verify({ ...saved(providerId), ...(model ? { model } : {}) }),
    agent,
  };
}
