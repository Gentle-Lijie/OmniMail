import test from "node:test";
import assert from "node:assert/strict";
import { insertFieldToken, splitFieldText } from "../src/lib/fieldInsertion.ts";
import { normalizeRecipients } from "../../server/recipients.ts";
import { mergeIssues, renderFields } from "../src/lib/mailMerge.ts";

test("field insertion keeps surrounding content and advances the caret for successive fields", () => {
  const first = insertFieldToken("Hello , welcome", "姓名", 6, 6);
  assert.deepEqual(first, { value: "Hello {{姓名}}, welcome", caret: 12 });
  const second = insertFieldToken(
    first.value,
    "部门",
    first.caret,
    first.caret,
  );
  assert.equal(second.value, "Hello {{姓名}}{{部门}}, welcome");
  assert.equal(
    insertFieldToken("Hello old name!", "姓名", 6, 14).value,
    "Hello {{姓名}}!",
  );
});
test("recipient field insertion preserves whole and partial email placeholders until merge", () => {
  const recipient = insertFieldToken("person@example.com;", "抄送邮箱").value;
  assert.equal(
    normalizeRecipients(recipient),
    "person@example.com;{{抄送邮箱}}",
  );
  const domain = insertFieldToken("person@.com", "域名", 7, 7).value;
  assert.equal(normalizeRecipients(domain), "person@{{域名}}.com");
  assert.equal(
    renderFields(normalizeRecipients(domain), { 域名: "example" }, {}),
    "person@example.com",
  );
});
test("field highlighting preserves plain text, adjacent fields and special characters", () => {
  const value = "通知 {{ 姓名 }}{{部门}} <script> & {{公司 名称}}";
  const segments = splitFieldText(value);
  assert.equal(segments.map((segment) => segment.text).join(""), value);
  assert.deepEqual(
    segments.filter((segment) => segment.field).map((segment) => segment.text),
    ["{{ 姓名 }}", "{{部门}}", "{{公司 名称}}"],
  );
  assert.deepEqual(splitFieldText("未完成 {{字段"), [
    { text: "未完成 {{字段", field: false },
  ]);
  assert.deepEqual(splitFieldText(""), []);
});
test("all mail and event payload fields can use rendered merge placeholders", () => {
  const row = {
    邮箱: "to@example.com",
    抄送: "cc@example.com",
    密送: "bcc@example.com",
    标题: "会议",
    正文: "通知",
    开始: "2026-10-08T10:00",
    结束: "2026-10-08T11:00",
    地点: "会议室",
  };
  assert.deepEqual(
    mergeIssues(
      "email",
      {
        to: "{{邮箱}}",
        cc: "{{抄送}}",
        bcc: "{{密送}}",
        subject: "{{标题}}",
        html: "{{正文}}",
      },
      [row],
      {},
    ),
    [],
  );
  assert.deepEqual(
    mergeIssues(
      "event",
      {
        requiredAttendees: "{{邮箱}}",
        optionalAttendees: "{{抄送}}",
        subject: "{{标题}}",
        html: "{{正文}}",
        start: "{{开始}}",
        end: "{{结束}}",
        location: "{{地点}}",
      },
      [row],
      {},
    ),
    [],
  );
});
