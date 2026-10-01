import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentIssue,
  readAgentResponse,
  AgentStreamError,
} from "../src/lib/agent.ts";

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
