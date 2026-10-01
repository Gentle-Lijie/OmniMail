import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { createStore, hash } from "./store.js";
import { buildApp } from "./app.js";
import { createAI } from "./ai.js";
import {
  readAgentAttachment,
  validateAttachments,
} from "./agentAttachments.js";
import { readProviderStream } from "./agentStream.js";

const secret = "agent-test-secret-long-enough-for-encryption";
const provider = {
  name: "Test",
  protocol: "openai-chat",
  baseUrl: "https://provider.invalid/v1",
  model: "test-model",
  apiKey: "test-secret",
  outputMode: "json",
};
const draft = {
  kind: "email",
  message: "已准备建议",
  payload: { subject: "跟进", html: "<p>请确认安排。</p>" },
};
const input = {
  kind: "email",
  message: "参考附件起草",
  payload: { subject: "", html: "", to: "original@example.com" },
};
function sse(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 5)
          controller.enqueue(bytes.slice(index, index + 5));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const chat = () =>
  sse([
    {
      choices: [
        { index: 0, delta: { reasoning_content: "核对资料与收件人。" } },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { content: JSON.stringify(draft) },
          finish_reason: "stop",
        },
      ],
    },
  ]);
function pdf(content: string) {
  const text = `BT /F1 12 Tf 72 720 Td (${content}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(source);
}
test("PDF and DOCX extraction reads only document text and rejects unreadable PDFs", async () => {
  const document = await readAgentAttachment(
    "brief.pdf",
    pdf("Reference facts"),
  );
  assert(document.kind === "text" && document.text.includes("Reference facts"));
  await assert.rejects(
    readAgentAttachment("blank.pdf", pdf("")),
    /No readable text/,
  );
  const archive = XLSX.CFB.utils.cfb_new();
  for (const [name, value] of Object.entries({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Project reference</w:t></w:r></w:p></w:body></w:document>',
  }))
    XLSX.CFB.utils.cfb_add(archive, name, Buffer.from(value));
  const word = await readAgentAttachment(
    "brief.docx",
    Buffer.from(XLSX.CFB.write(archive, { type: "buffer", fileType: "zip" })),
  );
  assert(word.kind === "text" && word.text.includes("Project reference"));
  await assert.rejects(
    readAgentAttachment("bad.docx", Buffer.from("not a ZIP")),
    /Invalid document archive/,
  );
});
test("native image context is encoded for all three protocols with JSON fallback compatibility", async () => {
  const image = await readAgentAttachment(
    "reference.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  for (const protocol of ["openai-chat", "openai-responses", "anthropic"]) {
    const store = createStore(":memory:", secret);
    const ai = createAI(store, (async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const content =
        protocol === "openai-responses"
          ? body.input[0].content
          : body.messages[protocol === "anthropic" ? 0 : 1].content;
      assert.equal(
        content[1].type,
        protocol === "anthropic"
          ? "image"
          : protocol === "openai-chat"
            ? "image_url"
            : "input_image",
      );
      const data =
        protocol === "anthropic"
          ? { content: [{ type: "text", text: JSON.stringify(draft) }] }
          : protocol === "openai-chat"
            ? { choices: [{ message: { content: JSON.stringify(draft) } }] }
            : { output_text: JSON.stringify(draft) };
      return Response.json(data);
    }) as typeof fetch);
    try {
      ai.save({ ...provider, protocol });
      const result = await ai.agent(
        { ...input, attachments: [image] },
        { onProgress: () => {} },
      );
      assert.equal(result.payload.to, "original@example.com");
    } finally {
      store.db.close();
    }
  }
});
test("Agent sends document context and streams provider thinking without executing tasks", async () => {
  const store = createStore(":memory:", secret);
  const progress: unknown[] = [];
  const ai = createAI(store, (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.stream, true);
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.documents[0].text, "项目背景");
    assert.equal(context.request.payload.to, "original@example.com");
    return chat();
  }) as typeof fetch);
  try {
    ai.save(provider);
    const result = await ai.agent(
      {
        ...input,
        attachments: [
          { kind: "text", name: "brief.txt", size: 12, text: "项目背景" },
        ],
      },
      { onProgress: (event) => progress.push(event) },
    );
    assert.equal(result.payload.to, "original@example.com");
    assert.deepEqual(progress, [
      { type: "progress", stage: "context" },
      { type: "progress", stage: "model" },
      { type: "thinking", text: "核对资料与收件人。" },
      { type: "progress", stage: "drafting" },
      { type: "progress", stage: "validating" },
    ]);
    assert.equal(
      (store.db.prepare("SELECT count(*) AS count FROM tasks").get() as any)
        .count,
      0,
    );
  } finally {
    store.db.close();
  }
});
test("JSON-only providers expose their returned thinking without inventing a stream", async () => {
  const store = createStore(":memory:", secret),
    events: unknown[] = [];
  const ai = createAI(store, (async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify(draft),
            reasoning_content: "核对参考事实",
          },
          finish_reason: "stop",
        },
      ],
    })) as typeof fetch);
  try {
    ai.save(provider);
    await ai.agent(input, { onProgress: (event) => events.push(event) });
    assert(
      events.some(
        (event: any) =>
          event.type === "thinking" && event.text === "核对参考事实",
      ),
    );
    assert.equal(
      events.filter((event: any) => event.stage === "drafting").length,
      1,
    );
  } finally {
    store.db.close();
  }
});
test("Responses and Anthropic streaming reconstruct structured output and reject truncation", async () => {
  const events: unknown[] = [];
  const responses = await readProviderStream(
    sse([
      { type: "response.reasoning_summary_text.delta", delta: "检查背景" },
      { type: "response.output_text.delta", delta: JSON.stringify(draft) },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]),
    "openai-responses",
    (event) => events.push(event),
  );
  assert.equal(responses.output_text, JSON.stringify(draft));
  const anthropic = await readProviderStream(
    sse([
      { type: "message_start", message: { content: [] } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "先整理资料" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", name: "submit_draft", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(draft),
        },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]),
    "anthropic",
    (event) => events.push(event),
  );
  assert.deepEqual(anthropic.content[1].input, draft);
  assert(events.some((event: any) => event.text === "先整理资料"));
  await assert.rejects(
    readProviderStream(
      sse([{ choices: [{ delta: { content: '{"partial": true' } }] }]),
      "openai-chat",
      () => {},
    ),
    /before completion/,
  );
});
test("attachment extraction accepts text and spreadsheets, rejects binary, empty and oversized files", async () => {
  const attachment = await readAgentAttachment(
    "../brief.txt",
    Buffer.from("客户背景"),
  );
  assert.equal(attachment.name, "brief.txt");
  assert.equal(attachment.kind, "text");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["项目", "说明"],
      ["试点", "下周沟通"],
    ]),
    "资料",
  );
  const excel = await readAgentAttachment(
    "brief.xlsx",
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
  );
  assert.equal(excel.kind, "text");
  assert(excel.kind === "text" && excel.text.includes("下周沟通"));
  await assert.rejects(
    readAgentAttachment("bad.exe", Buffer.from("binary")),
    /Unsupported file/,
  );
  await assert.rejects(
    readAgentAttachment("binary.txt", Buffer.from([0, 1, 2])),
    /Binary/,
  );
  await assert.rejects(
    readAgentAttachment("empty.txt", Buffer.alloc(0)),
    /non-empty/,
  );
  await assert.rejects(
    readAgentAttachment("large.txt", Buffer.alloc(5242881)),
    /5 MB/,
  );
  assert.throws(
    () =>
      validateAttachments([
        {
          kind: "image",
          name: "fake.png",
          size: 3,
          mediaType: "image/png",
          data: "YWJj",
        },
      ]),
    /Invalid image/,
  );
});
test("authenticated attachment and stream endpoints enforce CSRF and never create tasks", async () => {
  const fixture = await buildApp({
    secret,
    setupToken: "test",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
    staticRoot: "/nonexistent",
    fetcher: (async () => chat()) as typeof fetch,
  });
  const session = "agent-session",
    headers = {
      cookie: `omnimail=${session}`,
      "x-csrf-token": "csrf",
      accept: "text/event-stream",
    };
  fixture.store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash(session),
      JSON.stringify({ authenticated: true, csrfToken: "csrf" }),
      Date.now() + 60000,
    );
  try {
    assert.equal(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/api/agent/attachments",
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/api/agent",
          headers: { cookie: headers.cookie },
          payload: input,
        })
      ).statusCode,
      403,
    );
    await fixture.app.inject({
      method: "POST",
      url: "/api/providers",
      headers,
      payload: provider,
    });
    const result = await fixture.app.inject({
      method: "POST",
      url: "/api/agent",
      headers,
      payload: input,
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.headers["content-type"]!, /text\/event-stream/);
    assert(
      result.body.includes('"type":"thinking"') &&
        result.body.includes('"type":"result"'),
    );
    const boundary = "agent-upload-boundary";
    const uploaded = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/attachments",
      headers: {
        ...headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="brief.txt"\r\nContent-Type: text/plain\r\n\r\n参考资料\r\n--${boundary}--\r\n`,
      ),
    });
    assert.equal(uploaded.statusCode, 200);
    assert.equal(uploaded.json().text, "参考资料");
    assert.equal(
      (
        fixture.store.db
          .prepare("SELECT count(*) AS count FROM tasks")
          .get() as any
      ).count,
      0,
    );
  } finally {
    await fixture.app.close();
  }
});
