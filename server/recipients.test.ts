import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecipients, parseRecipients } from "./recipients.js";

test("parses the supplied Outlook recipients into addresses in order", () => {
  const input =
    "Matthew Pike <Matthew.Pike@nottingham.edu.cn>; Anthony Graham Bellotti <Anthony-Graham.Bellotti@nottingham.edu.cn>; Chin Poo Lee <Chin-Poo.Lee@nottingham.edu.cn>";
  assert.deepEqual(parseRecipients(input), [
    { kind: "email", value: "Matthew.Pike@nottingham.edu.cn" },
    { kind: "email", value: "Anthony-Graham.Bellotti@nottingham.edu.cn" },
    { kind: "email", value: "Chin-Poo.Lee@nottingham.edu.cn" },
  ]);
});
test("supports mixed separators, quoted names and adjacent bare addresses", () => {
  for (const separator of [
    "\n",
    "\r\n",
    "\t",
    " ",
    ",",
    ";",
    "，",
    "；",
    "、",
    "|",
    "/",
    "：",
  ]) {
    assert.equal(
      normalizeRecipients(`first@example.com${separator}second@example.com`),
      "first@example.com;second@example.com",
    );
  }
  assert.equal(
    normalizeRecipients(
      'first@example.com "Bellotti, Anthony" <second@example.com> 王小明 <third@example.com>',
    ),
    "first@example.com;second@example.com;third@example.com",
  );
  assert.equal(
    normalizeRecipients("(first@example.com) [second@example.com]"),
    "first@example.com;second@example.com",
  );
});
test("retains placeholders, duplicates and invalid entries instead of silently dropping them", () => {
  assert.deepEqual(
    parseRecipients(
      "{{ 收件人 邮箱 }};valid@example.com;bad@@example.com;invalid;A <bad@>;valid@example.com",
    ),
    [
      { kind: "placeholder", value: "{{ 收件人 邮箱 }}" },
      { kind: "email", value: "valid@example.com" },
      { kind: "invalid", value: "bad@@example.com" },
      { kind: "invalid", value: "invalid" },
      { kind: "invalid", value: "bad@" },
      { kind: "email", value: "valid@example.com" },
    ],
  );
  assert.equal(parseRecipients("a..b@example.com")[0]?.kind, "invalid");
  assert.equal(parseRecipients("a@example.c")[0]?.kind, "invalid");
  assert.deepEqual(parseRecipients("Empty person < >;valid@example.com"), [
    { kind: "invalid", value: "Empty person < >" },
    { kind: "email", value: "valid@example.com" },
  ]);
  assert.deepEqual(parseRecipients(" \n,;;，；"), []);
});
