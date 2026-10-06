export type AgentKind = "email" | "event";
export const draftFields = {
  email: ["to", "cc", "bcc", "subject", "html"],
  event: [
    "subject",
    "start",
    "end",
    "requiredAttendees",
    "optionalAttendees",
    "location",
    "html",
  ],
};
export interface AgentWorkspace {
  draftId: string;
  kind: AgentKind;
  payload: Record<string, string>;
  templateId?: string;
  mapping: Record<string, string>;
  recipientColumn: string;
  revision: number;
}
export interface AgentToolCall {
  callId: string;
  name: string;
  status: "running" | "complete" | "error";
  summary?: string;
}
export interface AgentProgress {
  type:
    | "progress"
    | "thinking"
    | "tool"
    | "workspace"
    | "refresh"
    | "review"
    | "open-draft";
  stage?: "context" | "model" | "drafting" | "validating";
  text?: string;
  tool?: AgentToolCall;
  workspace?: AgentWorkspace;
  taskId?: string;
  draftId?: string;
}
