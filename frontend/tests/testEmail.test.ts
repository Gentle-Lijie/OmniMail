import test from "node:test";
import assert from "node:assert/strict";
import { renderTestEmail, testEmailIssue } from "../src/lib/testEmail.ts";
import { setLocale } from "../src/lib/i18n.ts";

setLocale("en");
test("test content validates one selected sample without requiring original recipients or other rows", () => {
  const content = {
    subject: "Hello {{name}}",
    html: "<p>{{company}}</p>",
    row: {
      full_name: "Second",
      company: "<Client>",
      email: "invalid-original-recipient",
    },
    mapping: { name: "full_name" },
    sample: 1,
  };
  assert.equal(testEmailIssue(content, "Tester <test@example.com>"), "");
  assert.deepEqual(renderTestEmail(content), {
    subject: "Hello Second",
    html: "<p>&lt;Client&gt;</p>",
  });
  assert.equal(content.row.full_name, "Second");
  assert.match(
    testEmailIssue(content, "test@example.com,other@example.com"),
    /exactly one/,
  );
  assert.match(testEmailIssue(content, "{{email}}"), /exactly one/);
  assert.match(
    testEmailIssue({ ...content, row: {} }, "test@example.com"),
    /Missing field/,
  );
  assert.match(
    testEmailIssue(
      { ...content, mapping: { name: "missing" } },
      "test@example.com",
    ),
    /Missing field/,
  );
});

test("test rendering preserves literal merge syntax in values and handles zero and false", () => {
  const content = {
    subject: "{{name}}",
    html: "{{amount}} {{active}}",
    row: { name: "{{literal}}", amount: 0, active: false },
    mapping: {},
  };
  assert.equal(testEmailIssue(content, "test@example.com"), "");
  assert.deepEqual(renderTestEmail(content), {
    subject: "{{literal}}",
    html: "0 false",
  });
});
