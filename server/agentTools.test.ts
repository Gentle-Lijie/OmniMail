import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.js";
import { createAgentTools, type ToolContext } from "./agentTools.js";
import { createAI, ProviderError } from "./ai.js";
import { createDrafts } from "./drafts.js";
import { createTasks } from "./tasks.js";
import { createTemplates } from "./templates.js";
import { readProviderStream } from "./agentStream.js";
import { draftFields, type AgentProgress } from "./agentTypes.js";

const secret = "agent-tools-tests-isolated-at-least-32-characters";
const mail = {
  to: "scylz12@nottingham.edu.cn",
  cc: "",
  bcc: "",
  subject: "Original",
  html: "<p>Original</p>",
};
const fixture = (patch: Partial<ToolContext> = {}) => {
  const store = createStore(":memory:", secret);
  const events: AgentProgress[] = [];
  const context: ToolContext = {
    workspace: {
      draftId: "draft",
      kind: "email",
      payload: mail,
      revision: 0,
      mapping: {},
      recipientColumn: "",
    },
    rows: [],
    columns: [],
    attachments: [],
    conversation: [],
    onProgress: (event) => events.push(event),
    ...patch,
  };
  return { store, events, context, tools: createAgentTools(store, context) };
};
const call = (
  tools: ReturnType<typeof createAgentTools>,
  name: string,
  args: unknown = {},
) => tools.execute(name, args) as any;
const template = {
  name: "Weekly",
  kind: "email",
  subject: "Hello {{name}}",
  html: "<p>{{name}}</p>",
  fields: ["name"],
};

test("registry exposes all 28 business tools with bounded provider schemas", () => {
  const { store, tools } = fixture();
  try {
    assert.equal(tools.definitions.length, 28);
    assert.equal(new Set(tools.definitions.map((t) => t.name)).size, 28);
    for (const definition of tools.definitions) {
      assert.equal(definition.parameters.type, "object");
      assert.equal(definition.parameters.additionalProperties, false);
    }
    assert.deepEqual(
      tools.definitions.find((t) => t.name === "update_template")!.parameters
        .required,
      ["id", "expectedVersion", "patch"],
    );
    assert.throws(
      () => call(tools, "send_email", { payload: mail }),
      /Unknown tool/,
    );
    assert.throws(() => call(tools, "get_current_draft", { execute: true }));
  } finally {
    store.db.close();
  }
});

test("template tools CRUD, filter, version, rollback and reject stale or invalid writes", () => {
  const { store, tools } = fixture();
  try {
    const first = call(tools, "create_template", template);
    const unicode = call(tools, "create_template", {
      ...template,
      name: "中文模板",
      fields: ["姓名", "公司 名称"],
    });
    assert.deepEqual(unicode.fields, ["姓名", "公司 名称"]);
    assert.equal(
      call(tools, "list_templates", { query: "weekly" }).templates[0].id,
      first.id,
    );
    assert.equal(call(tools, "list_templates", { kind: "event" }).total, 0);
    assert.equal(
      call(tools, "get_template", { id: first.id }).html,
      template.html,
    );
    const second = call(tools, "update_template", {
      id: first.id,
      expectedVersion: 1,
      patch: { subject: "Edited" },
    });
    assert.equal(second.version, 2);
    assert.equal(second.html, template.html);
    assert.throws(
      () =>
        call(tools, "update_template", {
          id: first.id,
          expectedVersion: 1,
          patch: { subject: "Stale" },
        }),
      /latest version/,
    );
    assert.throws(() =>
      call(tools, "update_template", {
        id: first.id,
        expectedVersion: 2,
        patch: { arbitrary: "x" },
      }),
    );
    assert.equal(
      call(tools, "list_template_versions", { id: first.id, limit: 1 })
        .versions[0].version,
      2,
    );
    const restored = call(tools, "rollback_template", {
      id: first.id,
      expectedVersion: 2,
      version: 1,
    });
    assert.equal(restored.version, 3);
    assert.equal(restored.subject, template.subject);
    assert.throws(
      () =>
        call(tools, "delete_template", { id: first.id, expectedVersion: 2 }),
      /latest version/,
    );
    assert.equal(
      call(tools, "delete_template", { id: first.id, expectedVersion: 3 })
        .deleted,
      true,
    );
    assert.throws(
      () => call(tools, "get_template", { id: first.id }),
      /not found/,
    );
    assert.equal(call(tools, "list_templates").total, 1);
  } finally {
    store.db.close();
  }
});

test("draft tools retain unrelated fields, require revision and compatible templates", () => {
  const { store, tools, events } = fixture();
  try {
    const current = call(tools, "get_current_draft");
    assert.equal(current.revision, 0);
    assert.equal(current.draftId, "draft");
    assert.throws(
      () =>
        call(tools, "update_current_draft", {
          draftId: "other",
          expectedRevision: 0,
          patch: { subject: "x" },
        }),
      /Draft ID/,
    );
    assert.throws(
      () =>
        call(tools, "update_current_draft", {
          draftId: "draft",
          expectedRevision: 0,
          patch: { start: "2026-10-02T10:00:00" },
        }),
      /Unsupported/,
    );
    const updated = call(tools, "update_current_draft", {
      draftId: "draft",
      expectedRevision: 0,
      patch: { subject: "Changed", cc: "zljzljsweepy@qq.com" },
    });
    assert.equal(updated.payload.to, mail.to);
    assert.equal(updated.revision, 1);
    assert.throws(
      () =>
        call(tools, "update_current_draft", {
          draftId: "draft",
          expectedRevision: 0,
          patch: { subject: "Stale" },
        }),
      /latest revision/,
    );
    const t = call(tools, "create_template", {
      ...template,
      subject: "Template",
      html: "<p>Applied</p>",
    });
    const applied = call(tools, "apply_template", {
      id: t.id,
      expectedRevision: 1,
    });
    assert.equal(applied.payload.cc, "zljzljsweepy@qq.com");
    assert.equal(applied.templateId, t.id);
    assert.equal(call(tools, "preview_draft").payload.html, "<p>Applied</p>");
    assert.equal(call(tools, "validate_draft").valid, true);
    const saved = call(tools, "save_draft");
    assert.equal(saved.status, "draft");
    assert.equal(createDrafts(store).get(saved.id).templateId, t.id);
    assert.equal(createTasks(store).list().length, 0);
    assert(events.some((e) => e.type === "workspace"));
    call(tools, "delete_template", { id: t.id, expectedVersion: 1 });
    assert.equal(tools.state().templateId, undefined);
  } finally {
    store.db.close();
  }
});

test("draft tools expose and edit every kind-specific field including recipients and cleared values", () => {
  for (const kind of ["email", "event"] as const) {
    const original = Object.fromEntries(
      draftFields[kind].map((field) => [field, `original ${field}`]),
    );
    const { store, tools, events } = fixture({
      workspace: {
        draftId: "draft",
        kind,
        payload: original,
        mapping: {},
        recipientColumn: "",
        revision: 0,
      },
    });
    try {
      const definition = tools.definitions.find(
        (tool) => tool.name === "update_current_draft",
      )!;
      assert.deepEqual(
        Object.keys(definition.parameters.properties.patch.properties),
        draftFields[kind],
      );
      assert.equal(
        definition.parameters.properties.patch.additionalProperties,
        false,
      );
      for (const [index, field] of draftFields[kind].entries()) {
        const value =
          field === "cc" || field === "optionalAttendees"
            ? ""
            : `updated ${field}`;
        const updated = call(tools, "update_current_draft", {
          draftId: "draft",
          expectedRevision: index,
          patch: { [field]: value },
        });
        assert.equal(updated.payload[field], value);
        assert.equal(updated.revision, index + 1);
        for (const untouched of draftFields[kind].slice(index + 1))
          assert.equal(updated.payload[untouched], original[untouched]);
      }
      assert.equal(
        events.filter((event) => event.type === "workspace").length,
        draftFields[kind].length,
      );
      assert.throws(() =>
        call(tools, "update_current_draft", {
          draftId: "draft",
          expectedRevision: tools.state().revision,
          patch: {},
        }),
      );
      assert.equal(createTasks(store).list().length, 0);
    } finally {
      store.db.close();
    }
  }
});

test("batch tools confirm recipient columns, render safely and validate every row", () => {
  const rows = [
    { Email: "scylz12@nottingham.edu.cn", Name: "<b>A&B</b>" },
    { Email: "SCYLZ12@nottingham.edu.cn", Name: "" },
    { Email: "invalid", Name: "C" },
  ];
  const { store, tools } = fixture({
    rows,
    columns: ["Email", "Name"],
    workspace: {
      draftId: "draft",
      kind: "email",
      payload: {
        ...mail,
        to: "{{recipient}}",
        subject: "Hello {{name}}",
        html: "<p>{{name}}</p>",
      },
      mapping: {},
      recipientColumn: "",
      revision: 0,
    },
  });
  try {
    assert.equal(call(tools, "get_batch_schema").rowCount, 3);
    assert.throws(
      () =>
        call(tools, "set_field_mapping", {
          expectedRevision: 0,
          mapping: { name: "Unknown" },
        }),
      /Unknown/,
    );
    call(tools, "set_field_mapping", {
      expectedRevision: 0,
      mapping: { name: "Name", recipient: "Email" },
      recipientColumn: "Email",
    });
    const validation = call(tools, "validate_draft");
    assert.equal(validation.valid, false);
    assert(
      validation.issues.some(
        (i: any) => i.row === 2 && i.code === "duplicate_recipient",
      ),
    );
    assert(
      validation.issues.some(
        (i: any) => i.row === 2 && i.code === "missing_field",
      ),
    );
    assert(
      validation.issues.some(
        (i: any) => i.row === 3 && i.code === "invalid_payload",
      ),
    );
    const preview = call(tools, "preview_draft", { rowIndex: 0 });
    assert.equal(preview.payload.html, "<p>&lt;b&gt;A&amp;B&lt;/b&gt;</p>");
    assert.deepEqual(
      call(tools, "get_batch_row", { rowIndex: 0, columns: ["Name"] }).row,
      { Name: rows[0].Name },
    );
    assert.throws(
      () => call(tools, "get_batch_row", { rowIndex: 5 }),
      /out of range/,
    );
    assert.equal(call(tools, "save_draft").status, "draft");
    assert.throws(
      () => call(tools, "request_execution_confirmation"),
      /validation failed/,
    );
  } finally {
    store.db.close();
  }
});

test("valid batches save mapped rows; event tools validate Beijing timestamps", () => {
  const { store, tools } = fixture({
    columns: ["Email", "Name"],
    rows: [{ Email: "scylz12@nottingham.edu.cn", Name: "Zero" }],
    workspace: {
      draftId: "draft",
      kind: "email",
      payload: { ...mail, to: "{{Email}}", html: "<p>{{name}}</p>" },
      mapping: { name: "Name" },
      recipientColumn: "Email",
      revision: 0,
    },
  });
  try {
    const saved = call(tools, "save_draft");
    assert.equal(
      createTasks(store).get(call(tools, "request_execution_confirmation").id)
        .items[0].payload.html,
      "<p>Zero</p>",
    );
    const eventTools = createAgentTools(store, {
      workspace: {
        draftId: "event",
        kind: "event",
        payload: {
          subject: "Meeting",
          start: "2026-02-30T10:00:00",
          end: "2026-02-30T11:00:00",
          requiredAttendees: "",
          optionalAttendees: "",
          location: "",
          html: "",
        },
        mapping: {},
        recipientColumn: "",
        revision: 0,
      },
      rows: [],
      columns: [],
      attachments: [],
      conversation: [],
    });
    assert.equal(call(eventTools, "validate_draft").valid, false);
    call(eventTools, "update_current_draft", {
      draftId: "event",
      expectedRevision: 0,
      patch: { start: "2026-10-02T10:00:00", end: "2026-10-02T11:00:00" },
    });
    assert.equal(call(eventTools, "validate_draft").valid, true);
  } finally {
    store.db.close();
  }
});

test("task tools paginate all records, filter dates, cancel pending items and only request human review", () => {
  const { store, tools, events } = fixture();
  try {
    for (let index = 0; index < 505; index++)
      createTasks(store).create({
        kind: "email",
        payload: { ...mail, subject: `Item ${index}` },
      });
    const tasks = call(tools, "list_tasks", {
      status: "draft",
      offset: 500,
      limit: 10,
      from: "2020-01-01",
      to: "2100-01-01",
    });
    assert.equal(tasks.total, 505);
    assert.equal(tasks.tasks.length, 5);
    assert.equal(call(tools, "list_tasks", { query: "Item 504" }).total, 1);
    assert.equal(
      call(tools, "get_task", { id: tasks.tasks[0].id }).status,
      "draft",
    );
    assert.equal(
      call(tools, "cancel_task", { id: tasks.tasks[0].id }).status,
      "cancelled",
    );
    const preparation = call(tools, "prepare_execution");
    assert.equal(preparation.requiresHumanConfirmation, true);
    assert.equal(preparation.valid, true);
    const saved = call(tools, "save_draft");
    const review = call(tools, "request_execution_confirmation");
    assert.notEqual(review.id, saved.id);
    assert.equal(createTasks(store).get(review.id).sourceDraftId, saved.id);
    assert.equal(review.queued, false);
    assert.equal(createTasks(store).get(review.id).status, "draft");
    assert(events.some((e) => e.type === "review" && e.taskId === review.id));
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE json_extract(value,'$.status')='queued'",
        )
        .get() &&
        (
          store.db
            .prepare(
              "SELECT count(*) AS n FROM tasks WHERE json_extract(value,'$.status')='queued'",
            )
            .get() as any
        ).n,
      0,
    );
  } finally {
    store.db.close();
  }
});

test("attachment tools address stable IDs, bound excerpts and exclude unrelated documents", () => {
  const { store, tools } = fixture({
    attachments: [
      {
        kind: "text",
        name: "contract.txt",
        size: 12,
        text: "Payment deadline is Friday. Payment requires approval.",
      },
      { kind: "text", name: "other.txt", size: 5, text: "Other reference" },
    ],
  });
  try {
    const index = tools.attachmentIndex;
    assert.equal(index.length, 2);
    assert.equal(index[0].id.length, 24);
    const excerpt = call(tools, "read_attachment", {
      id: index[0].id,
      offset: 0,
      length: 7,
    });
    assert.equal(excerpt.text, "Payment");
    assert.equal(excerpt.hasMore, true);
    const matches = call(tools, "search_attachment", {
      id: index[0].id,
      query: "payment",
      limit: 1,
    }).matches;
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, "contract.txt");
    assert.throws(
      () => call(tools, "read_attachment", { id: "other-conversation" }),
      /not found/,
    );
    assert.throws(
      () => call(tools, "read_attachment", { id: index[0].id, offset: 999 }),
      /out of range/,
    );
    assert.throws(() =>
      call(tools, "read_attachment", { id: index[0].id, length: 12001 }),
    );
  } finally {
    store.db.close();
  }
});

test("persistent tool retries are idempotent per principal and request, and cancellation prevents writes", () => {
  const { store, context, tools } = fixture({
    requestId: "stable-request",
    principal: "user-a",
  });
  try {
    const first = call(tools, "create_template", template);
    const repeat = createAgentTools(store, context);
    assert.equal(call(repeat, "create_template", template).id, first.id);
    assert.equal(createTemplates(store).list().length, 1);
    const update = {
      id: first.id,
      expectedVersion: 1,
      patch: { subject: "Edited" },
    };
    assert.equal(call(tools, "update_template", update).version, 2);
    assert.equal(call(repeat, "update_template", update).version, 2);
    assert.equal(createTemplates(store).versions(first.id).length, 2);
    const other = createAgentTools(store, { ...context, principal: "user-b" });
    assert.notEqual(call(other, "create_template", template).id, first.id);
    const controller = new AbortController();
    controller.abort();
    const cancelled = createAgentTools(store, {
      ...context,
      signal: controller.signal,
    });
    assert.throws(() => call(cancelled, "create_template", template));
    assert.throws(() =>
      call(tools, "set_field_mapping", {
        expectedRevision: 0,
        mapping: JSON.parse('{"__proto__":"Name"}'),
      }),
    );
  } finally {
    store.db.close();
  }
});

const providerResponse = (
  protocol: string,
  calls?: { name: string; args: unknown; id: string }[],
  final?: unknown,
) =>
  Response.json(
    protocol === "anthropic"
      ? {
          content: calls
            ? calls.map((call) => ({
                type: "tool_use",
                name: call.name,
                id: call.id,
                input: call.args,
              }))
            : [
                {
                  type: "tool_use",
                  id: "final",
                  name: "submit_draft",
                  input: final,
                },
              ],
          stop_reason: "tool_use",
        }
      : protocol === "openai-chat"
        ? {
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: (
                    calls ?? [
                      { name: "submit_draft", args: final, id: "final" },
                    ]
                  ).map((call) => ({
                    id: call.id,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args),
                    },
                  })),
                },
                finish_reason: "tool_calls",
              },
            ],
          }
        : {
            status: "completed",
            output: (
              calls ?? [{ name: "submit_draft", args: final, id: "final" }]
            ).map((call) => ({
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.args),
            })),
          },
  );

test("all providers return full-field suggestions and retain all fields in follow-up context", async () => {
  for (const protocol of [
    "anthropic",
    "openai-chat",
    "openai-responses",
  ] as const) {
    for (const kind of ["email", "event"] as const) {
      const store = createStore(":memory:", secret);
      const payload = Object.fromEntries(
        draftFields[kind].map((field) => [field, `suggested ${field}`]),
      );
      const ai = createAI(store, (async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        const history =
          protocol === "openai-responses" ? body.input : body.messages;
        const context = JSON.parse(
          history[protocol === "openai-chat" ? 1 : 0].content,
        );
        assert.deepEqual(context.request.suggestion, payload);
        return providerResponse(protocol, undefined, {
          kind,
          message: "All fields suggested",
          payload,
        });
      }) as typeof fetch);
      try {
        ai.save({
          name: "Fake",
          protocol,
          baseUrl: "https://model.invalid/v1",
          model: "test",
          apiKey: "fake",
          outputMode: "prompt",
        });
        const current = Object.fromEntries(
          draftFields[kind].map((field) => [field, `original ${field}`]),
        );
        const result = await ai.agent({
          kind,
          message: "Refine all fields",
          payload: current,
          suggestion: payload,
        });
        assert.deepEqual(result.payload, payload);
        assert.deepEqual(result.workspace.payload, current);
        assert.equal(result.hasSuggestion, true);
        assert.equal(result.workspaceChanged, false);
        assert.equal(createTasks(store).list().length, 0);
      } finally {
        store.db.close();
      }
    }
  }
});

test("recipient mapping-only suggestions remain available for application", async () => {
  const store = createStore(":memory:", secret);
  const payload = { ...mail, to: "{{recipient}}" };
  const ai = createAI(store, (async () =>
    providerResponse("openai-chat", undefined, {
      message: "Use Email for the recipient",
      kind: "email",
      payload: {},
      mapping: { recipient: "Email" },
    })) as typeof fetch);
  try {
    ai.save({
      name: "Fake",
      protocol: "openai-chat",
      baseUrl: "https://model.invalid/v1",
      model: "test",
      apiKey: "fake",
      outputMode: "prompt",
    });
    const result = await ai.agent({
      kind: "email",
      message: "Suggest a recipient mapping",
      payload,
      columns: ["Email"],
    });
    assert.deepEqual(result.payload, payload);
    assert.equal(result.hasSuggestion, true);
    assert.equal(result.mapping?.recipient, "Email");
    assert.deepEqual(result.workspace.mapping, {});
    await assert.rejects(
      ai.agent({
        kind: "email",
        message: "Refine",
        payload,
        suggestion: {
          subject: "Subject",
          html: "Body",
          start: "2026-10-03T10:00:00",
        },
      }),
      /unsupported draft fields/i,
    );
  } finally {
    store.db.close();
  }
});

test("all three providers perform read/edit/read loops with tool feedback and preserve sensitive batch rows", async () => {
  for (const protocol of [
    "anthropic",
    "openai-chat",
    "openai-responses",
  ] as const) {
    const store = createStore(":memory:", secret);
    let round = 0;
    const events: AgentProgress[] = [];
    const ai = createAI(store, (async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.tools.length, 29);
      assert(!JSON.stringify(body).includes("private-row-value"));
      round++;
      if (round === 1)
        return providerResponse(protocol, [
          { id: "read", name: "get_current_draft", args: {} },
        ]);
      const history =
        protocol === "openai-responses" ? body.input : body.messages;
      assert(
        JSON.stringify(history).includes('"revision":0') ||
          JSON.stringify(history).includes('\\"revision\\":0'),
      );
      if (round === 2)
        return providerResponse(protocol, [
          {
            id: "edit",
            name: "update_current_draft",
            args: {
              draftId: "draft",
              expectedRevision: 0,
              patch: {
                to: "updated@example.com",
                cc: "copy@example.com",
                bcc: "",
                subject: "Updated by tool",
              },
            },
          },
        ]);
      return providerResponse(protocol, undefined, {
        message: "Edited",
        kind: "email",
        payload: {},
      });
    }) as typeof fetch);
    try {
      ai.save({
        name: "Fake",
        protocol,
        baseUrl: "https://model.invalid/v1",
        model: "test",
        apiKey: "fake",
        outputMode: "prompt",
      });
      const result = await ai.agent(
        {
          draftId: "draft",
          message: "Edit",
          kind: "email",
          payload: mail,
          columns: ["Name"],
          rows: [{ Name: "private-row-value" }],
        },
        { onProgress: (event) => events.push(event) },
      );
      assert.equal(round, 3);
      assert.equal(result.payload.subject, "Updated by tool");
      assert.equal(result.payload.to, "updated@example.com");
      assert.equal(result.payload.cc, "copy@example.com");
      assert.equal(result.payload.bcc, "");
      assert.equal(result.workspaceChanged, true);
      assert.equal(result.hasSuggestion, false);
      assert(
        events.some((e) => e.type === "tool" && e.tool?.status === "complete"),
      );
    } finally {
      store.db.close();
    }
  }
});

test("invalid tool arguments are returned to the model for recovery without a write", async () => {
  const store = createStore(":memory:", secret);
  let round = 0;
  const ai = createAI(store, (async (_url, options) => {
    round++;
    if (round === 1)
      return providerResponse("openai-chat", [
        {
          id: "bad",
          name: "update_current_draft",
          args: {
            draftId: "draft",
            expectedRevision: 0,
            patch: { arbitrary: "x" },
          },
        },
      ]);
    const body = JSON.parse(String(options?.body));
    const toolResult = JSON.parse(body.messages.at(-1).content);
    assert.equal(toolResult.ok, false);
    return providerResponse("openai-chat", undefined, {
      kind: "email",
      message: "Invalid field rejected",
      payload: {},
    });
  }) as typeof fetch);
  try {
    ai.save({
      name: "Fake",
      protocol: "openai-chat",
      baseUrl: "https://model.invalid",
      model: "test",
      apiKey: "fake",
    });
    const result = await ai.agent({
      draftId: "draft",
      message: "Edit",
      kind: "email",
      payload: mail,
    });
    assert.equal(result.workspaceChanged, false);
    assert.equal(result.payload.subject, mail.subject);
  } finally {
    store.db.close();
  }
});

test("incomplete generations never execute tool arguments, and looping providers are bounded", async () => {
  for (const incomplete of [true, false]) {
    const store = createStore(":memory:", secret);
    let count = 0;
    const ai = createAI(store, (async () => {
      count++;
      if (incomplete)
        return Response.json({
          status: "incomplete",
          output: [
            {
              type: "function_call",
              call_id: "create",
              name: "create_template",
              arguments: JSON.stringify(template),
            },
          ],
        });
      return providerResponse("openai-responses", [
        { id: `read-${count}`, name: "get_current_draft", args: {} },
      ]);
    }) as typeof fetch);
    try {
      ai.save({
        name: "Fake",
        protocol: "openai-responses",
        baseUrl: "https://model.invalid",
        model: "test",
        apiKey: "fake",
      });
      await assert.rejects(
        ai.agent({ message: "Create", kind: "email", payload: mail }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.code === (incomplete ? "output_incomplete" : "agent_tools"),
      );
      assert.equal(createTemplates(store).list().length, 0);
      assert.equal(count, incomplete ? 1 : 16);
    } finally {
      store.db.close();
    }
  }
});

test("Chat streams reconstruct fragmented names, arguments and IDs before execution", async () => {
  const events = [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-",
                function: { name: "get_", arguments: "{" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "one",
                function: { name: "current_draft", arguments: "}" },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const response = new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  );
  const data = await readProviderStream(response, "openai-chat", () => {});
  assert.deepEqual(data.choices[0].message.tool_calls, [
    {
      id: "call-one",
      type: "function",
      function: { name: "get_current_draft", arguments: "{}" },
    },
  ]);
});

test("cancelling after a committed template write stops the next model request and retains the version", async () => {
  const store = createStore(":memory:", secret);
  const controller = new AbortController();
  let requests = 0;
  const ai = createAI(store, (async () => {
    requests++;
    return providerResponse("anthropic", [
      { id: "create", name: "create_template", args: template },
    ]);
  }) as typeof fetch);
  try {
    ai.save({
      name: "Fake",
      protocol: "anthropic",
      baseUrl: "https://model.invalid",
      model: "test",
      apiKey: "fake",
    });
    await assert.rejects(
      ai.agent(
        { message: "Create a template", kind: "email", payload: mail },
        {
          signal: controller.signal,
          onProgress: (event) => {
            if (event.type === "tool" && event.tool?.status === "complete")
              controller.abort();
          },
        },
      ),
    );
    assert.equal(requests, 1);
    assert.equal(createTemplates(store).list().length, 1);
    assert.equal(createTemplates(store).list()[0].version, 1);
  } finally {
    store.db.close();
  }
});

test("Responses refusal alongside a function call never executes a template write", async () => {
  const store = createStore(":memory:", secret);
  const ai = createAI(store, (async () =>
    Response.json({
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "create",
          name: "create_template",
          arguments: JSON.stringify(template),
        },
        {
          type: "message",
          content: [{ type: "refusal", refusal: "Cannot comply" }],
        },
      ],
    })) as typeof fetch);
  try {
    ai.save({
      name: "Fake",
      protocol: "openai-responses",
      baseUrl: "https://model.invalid",
      model: "test",
      apiKey: "fake",
    });
    await assert.rejects(
      ai.agent({ message: "Create", kind: "email", payload: mail }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "output_refused",
    );
    assert.equal(createTemplates(store).list().length, 0);
  } finally {
    store.db.close();
  }
});
