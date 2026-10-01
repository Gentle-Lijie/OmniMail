import test from "node:test";
import assert from "node:assert/strict";
import {
  fieldsIn,
  renderFields,
  mergeIssues,
  mappedRows,
  recommendedEmailColumn,
  previewDocument,
} from "../src/lib/mailMerge.ts";
const payload = {
  to: "{{邮箱}}",
  cc: "",
  bcc: "",
  subject: "给 {{姓名}} 的通知",
  html: "<p>{{公司}}</p>",
};
test("recognizes Unicode, spaced and dotted field names without duplicates", () => {
  assert.deepEqual(
    fieldsIn({
      subject: "{{ 姓名 }} {{customer.name}}",
      html: "{{姓名}} {{公司 名称}}",
    }),
    ["姓名", "customer.name", "公司 名称"],
  );
});
test("HTML values are escaped while subjects stay plain text", () => {
  const row = { 姓名: '<img src=x onerror=alert(1)> & "客户"' };
  assert.equal(
    renderFields("{{姓名}}", row, {}, true),
    "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;客户&quot;",
  );
  assert.equal(renderFields("{{姓名}}", row, {}), row.姓名);
});
test("mapping works for previews and transport without mutating source rows", () => {
  const rows = [{ email_address: "client@example.com", full_name: "林悦" }];
  const mapping = { 邮箱: "email_address", 姓名: "full_name" };
  assert.equal(renderFields("{{姓名}}", rows[0]!, mapping), "林悦");
  assert.deepEqual(mappedRows(rows, mapping)[0], {
    ...rows[0],
    邮箱: "client@example.com",
    姓名: "林悦",
  });
  assert.equal("姓名" in rows[0]!, false);
});
test("validates every row, not only the visible page", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    邮箱: `client${index}@example.com`,
    姓名: "客户",
    公司: "公司",
  }));
  rows[10]!.邮箱 = "bad";
  assert.ok(
    mergeIssues("email", payload, rows, {}).some(
      (issue) => issue.row === 11 && issue.field === "to",
    ),
  );
});
test("blocks empty fields and duplicate recipients across the whole batch", () => {
  const issues = mergeIssues(
    "email",
    payload,
    [
      { 邮箱: "client@example.com", 姓名: "客户", 公司: "" },
      { 邮箱: "CLIENT@example.com", 姓名: "客户", 公司: "公司" },
    ],
    {},
  );
  assert.ok(issues.some((issue) => issue.row === 1 && issue.field === "公司"));
  assert.ok(
    issues.some((issue) => issue.row === 2 && /Duplicate/.test(issue.message)),
  );
});
test("manual recipients use semicolons and do not require an imported list", () => {
  assert.deepEqual(
    mergeIssues(
      "email",
      {
        to: "one@example.com;two@example.com",
        subject: "通知",
        html: "<p>正文</p>",
      },
      [],
      {},
    ),
    [],
  );
  assert.ok(
    mergeIssues(
      "email",
      { to: "one@example.com,two@example.com", subject: "通知", html: "正文" },
      [],
      {},
    ).length,
  );
});
test("numeric zero and boolean false are valid merge values", () => {
  assert.deepEqual(
    mergeIssues(
      "email",
      { to: "client@example.com", subject: "{{amount}}", html: "{{active}}" },
      [{ amount: 0, active: false }],
      {},
    ),
    [],
  );
});
test("recipient detection only recommends an unambiguous email column", () => {
  assert.equal(recommendedEmailColumn(["姓名", "邮箱"]), "邮箱");
  assert.equal(recommendedEmailColumn(["邮箱", "email"]), "");
  assert.equal(recommendedEmailColumn(["联系信息"]), "");
});
test("unresolved variables remain visible and block saving", () => {
  assert.equal(renderFields("{{missing}}", {}, {}), "{{missing}}");
  assert.ok(
    mergeIssues(
      "email",
      { to: "client@example.com", subject: "{{missing}}", html: "正文" },
      [],
      {},
    ).some((issue) => issue.field === "missing"),
  );
});
test("inherited properties cannot be treated as merge values", () => {
  assert.equal(renderFields("{{toString}}", {}, {}), "{{toString}}");
  assert.ok(
    mergeIssues(
      "email",
      { to: "client@example.com", subject: "{{toString}}", html: "正文" },
      [],
      {},
    ).some((issue) => issue.field === "toString"),
  );
});
test("previews deny scripts, network, forms and base URL overrides", () => {
  const preview = previewDocument("<p>邮件</p>");
  assert.ok(preview.includes("default-src 'none'"));
  assert.ok(preview.includes("form-action 'none'"));
  assert.ok(preview.includes("base-uri 'none'"));
});
test("event times require an ordered, valid range", () => {
  const event = {
    subject: "交流",
    html: "",
    start: "2026-10-08T10:00",
    end: "2026-10-08T11:00",
    requiredAttendees: "client@example.com",
  };
  assert.deepEqual(mergeIssues("event", event, [], {}), []);
  assert.ok(
    mergeIssues("event", { ...event, end: "2026-10-08T09:00" }, [], {}).some(
      (issue) => issue.field === "start",
    ),
  );
});
