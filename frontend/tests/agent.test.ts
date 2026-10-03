import { setLocale } from "../src/lib/i18n.ts";
setLocale("en");
import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentIssue,
  readAgentResponse,
  AgentStreamError,
  applyDraftSuggestion,
} from "../src/lib/agent.ts";

test("email suggestions apply recipients, CC, BCC and content while preserving omitted fields", () => {
  const workspace = {
    kind: "email" as const,
    payload: {
      to: "old@example.com",
      cc: "keep@example.com",
      bcc: "remove@example.com",
      subject: "Old",
      html: "<p>Old</p>",
    },
    mapping: { name: "Name" },
  };
  const applied = applyDraftSuggestion(
    workspace,
    {
      kind: "email",
      payload: {
        to: "new@example.com",
        bcc: "",
        subject: "New",
        html: "<p>New</p>",
      },
    },
    ["Name"],
  );
  assert.deepEqual(applied.payload, {
    to: "new@example.com",
    cc: "keep@example.com",
    bcc: "",
    subject: "New",
    html: "<p>New</p>",
  });
  assert.deepEqual(applied.mapping, workspace.mapping);
  assert.equal(workspace.payload.to, "old@example.com");
});

test("event suggestions apply all attendees, times, location and content", () => {
  const payload = {
    requiredAttendees: "new@example.com",
    optionalAttendees: "",
    start: "2026-10-03T10:00:00",
    end: "2026-10-03T11:00:00",
    location: "Room 2",
    subject: "Meeting",
    html: "<p>Agenda</p>",
  };
  const applied = applyDraftSuggestion(
    {
      kind: "event",
      payload: {
        ...payload,
        requiredAttendees: "old@example.com",
        optionalAttendees: "remove@example.com",
        location: "Room 1",
      },
      mapping: {},
    },
    { kind: "event", payload },
    [],
  );
  assert.deepEqual(applied.payload, payload);
});

test("suggestions can change recipient placeholder mappings without discarding other mappings", () => {
  const workspace = {
    kind: "email" as const,
    payload: {
      to: "{{recipient}}",
      cc: "{{copy}}",
      subject: "Hello",
      html: "Hi",
    },
    mapping: { recipient: "OldEmail", name: "Name" },
  };
  const applied = applyDraftSuggestion(
    workspace,
    {
      kind: "email",
      payload: {},
      mapping: { recipient: "Email", copy: "CC" },
    },
    ["OldEmail", "Email", "CC", "Name"],
  );
  assert.deepEqual(applied.mapping, {
    recipient: "Email",
    copy: "CC",
    name: "Name",
  });
  assert.deepEqual(applied.payload, workspace.payload);
});

test("suggestions reject mismatched kinds, unsupported fields and unknown columns before applying", () => {
  const workspace = {
    kind: "email" as const,
    payload: { to: "old@example.com", subject: "Original", html: "Hi" },
    mapping: {},
  };
  for (const suggestion of [
    { kind: "event" as const, payload: { subject: "New" } },
    { kind: "email" as const, payload: { start: "2026-10-03T10:00:00" } },
    {
      kind: "email" as const,
      payload: { subject: "New" },
      mapping: { recipient: "Unknown" },
    },
  ])
    assert.throws(
      () => applyDraftSuggestion(workspace, suggestion, []),
      /invalid suggestion/i,
    );
  assert.equal(workspace.payload.subject, "Original");
  assert.deepEqual(workspace.mapping, {});
});

function response(events: unknown[], ending = "\r\n\r\n") {
  const bytes = new TextEncoder().encode(
    ": heartbeat" +
      ending +
      events.map((event) => `data: ${JSON.stringify(event)}${ending}`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 3)
          controller.enqueue(bytes.slice(index, index + 3));
        controller.close();
      },
    }),
  );
}
test("agent streams progress and Unicode thinking before a complete result", async () => {
  const events: unknown[] = [];
  const result = await readAgentResponse(
    response([
      { type: "progress", stage: "model" },
      { type: "thinking", text: "先核对参考资料" },
      { type: "result", result: { message: "已准备" } },
    ]),
    (event) => events.push(event),
  );
  assert.deepEqual(result, { message: "已准备" });
  assert.deepEqual(events, [
    { type: "progress", stage: "model" },
    { type: "thinking", text: "先核对参考资料" },
  ]);
});
test("agent rejects incomplete streams and surfaces error codes without applying results", async () => {
  await assert.rejects(
    readAgentResponse(
      response([{ type: "progress", stage: "model" }], "\n\n"),
      () => {},
    ),
    /before a complete draft/,
  );
  await assert.rejects(
    readAgentResponse(
      response([
        { type: "error", error: "Provider unavailable", code: "provider_http" },
      ]),
      () => {},
    ),
    (error) =>
      error instanceof AgentStreamError && error.code === "provider_http",
  );
});
test("attachment checks enforce supported types, counts, individual and combined image limits", () => {
  assert.equal(
    attachmentIssue([], [{ name: "brief.md", size: 10 }]),
    undefined,
  );
  assert.equal(attachmentIssue([], [{ name: "bad.exe", size: 10 }]), "type");
  assert.equal(attachmentIssue([], [{ name: "empty.txt", size: 0 }]), "size");
  assert.equal(
    attachmentIssue(
      [],
      Array.from({ length: 6 }, () => ({ name: "brief.txt", size: 1 })),
    ),
    "count",
  );
  assert.equal(
    attachmentIssue(
      [{ kind: "image", name: "photo.jpg", size: 2000000 }],
      [{ name: "chart.png", size: 1500000 }],
    ),
    "context",
  );
});

test("tool and workspace events are delivered before a later error so completed changes remain visible", async () => {
  const events: unknown[] = [];
  const workspace = {
    draftId: "draft",
    kind: "email",
    payload: { subject: "Edited", html: "<p>Edited</p>" },
    revision: 1,
    mapping: {},
    recipientColumn: "",
  };
  await assert.rejects(
    readAgentResponse(
      response([
        {
          type: "tool",
          tool: {
            callId: "edit",
            name: "update_current_draft",
            status: "running",
          },
        },
        { type: "workspace", workspace },
        {
          type: "tool",
          tool: {
            callId: "edit",
            name: "update_current_draft",
            status: "complete",
          },
        },
        { type: "refresh" },
        { type: "review", taskId: "task" },
        {
          type: "error",
          error: "Connection lost",
          code: "provider_connection",
        },
      ]),
      (event) => events.push(event),
    ),
    /Connection lost/,
  );
  assert.equal(events.length, 5);
  assert.deepEqual(events[1], { type: "workspace", workspace });
});
