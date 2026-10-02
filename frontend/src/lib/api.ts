import { message, i18n } from "./i18n";
import {
  readAgentResponse,
  AgentStreamError,
  type AgentProgress,
} from "./agent";

export interface AuthStatus {
  authenticated: boolean;
  registrationEnabled: boolean;
  needsSetup: boolean;
  csrfToken: string;
}
export type Kind = "email" | "event";
export interface Payload {
  [key: string]: string;
  subject: string;
  html: string;
}
export interface Template {
  id: string;
  name: string;
  description: string;
  kind: Kind;
  subject: string;
  html: string;
  fields: string[];
  version: number;
  createdAt: string;
}
export type TaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "accepted"
  | "failed"
  | "uncertain"
  | "cancelled";
export interface Task {
  id: string;
  kind: Kind;
  source: string;
  status: TaskStatus;
  createdAt: string;
  summary: string;
  total: number;
  accepted: number;
  failed: number;
  templateId?: string;
  template?: Template;
  payload?: Payload;
  items?: {
    id: string;
    status: TaskStatus;
    payload: Payload;
    error?: string;
    errorKey?: string;
    errorValues?: Record<string, string | number>;
  }[];
  conversation?: Message[];
}
export interface Message {
  role: string;
  content: string;
  attachments?: { name: string; size: number }[];
  thinking?: string;
  stages?: string[];
  status?: "pending" | "complete" | "error" | "cancelled";
  toolCalls?: import("./agent").AgentToolCall[];
}
export interface Provider {
  id: string;
  name: string;
  protocol: "openai-responses" | "openai-chat" | "anthropic";
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
  hasApiKey?: boolean;
  hasHeaders?: boolean;
  outputMode?: "auto" | "json" | "prompt";
}
export interface Settings {
  registrationEnabled: boolean;
  language: string;
  rateLimitMs: number;
  prompt: string;
  providers: Provider[];
  defaultProviderId: string;
  mailConfigured: boolean;
  eventConfigured: boolean;
}
export interface Key {
  id: string;
  name: string;
  prefix?: string;
  createdAt: string;
}
let csrf = "";
export function setCsrf(token: string) {
  csrf = token;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options: {
    signal?: AbortSignal;
    onProgress?: (event: AgentProgress) => void;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": i18n.global.locale.value,
  };
  if (options.onProgress) headers.Accept = "text/event-stream";
  if (method !== "GET" && !/^\/auth\/(register|login)\//.test(path)) {
    if (!csrf) throw new ApiError(message("api.csrfUnavailable"), 403);
    headers["X-CSRF-Token"] = csrf;
  }
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart)
    headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    path === "/agent" ? 195000 : 60000,
  );
  try {
    const response = await fetch("/api" + path, {
      method,
      headers,
      credentials: "same-origin",
      body:
        body === undefined
          ? undefined
          : multipart
            ? (body as FormData)
            : JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
    });
    if (
      response.ok &&
      options.onProgress &&
      response.headers.get("content-type")?.includes("text/event-stream")
    )
      return await readAgentResponse<T>(response, options.onProgress);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError(
        message("api.invalidResponse", { status: response.status }),
        response.status,
      );
    }
    if (!response.ok) {
      const error = data as
        | {
            error?: string | { message?: string };
            message?: string;
            code?: string;
          }
        | undefined;
      throw new ApiError(
        typeof error?.error === "string"
          ? error.error
          : error?.message ||
              (typeof error?.error === "object"
                ? error.error.message
                : undefined) ||
              message("api.httpError", { status: response.status }),
        response.status,
        error?.code,
      );
    }
    return data as T;
  } catch (e) {
    if (e instanceof AgentStreamError)
      throw new ApiError(e.message, 400, e.code);
    if (options.signal?.aborted)
      throw new ApiError(message("api.cancelled"), 0, "cancelled");
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      e instanceof Error && e.name === "AbortError"
        ? message("api.timeout")
        : message("api.unreachable"),
      0,
    );
  } finally {
    clearTimeout(timeout);
  }
}
export const idPath = (id: string) => encodeURIComponent(id);
