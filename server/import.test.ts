import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { buildApp } from "./app.js";
import { hash } from "./store.js";
test("Excel import works and rejects oversized or unsafe headers", async () => {
  const { app, store } = await buildApp({
    secret: "test-secret-more-than-32-characters",
    setupToken: "test-setup",
    origin: "http://localhost:5173",
    dbPath: ":memory:",
    worker: false,
    staticRoot: "/nonexistent",
  });
  store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(
      hash("session"),
      JSON.stringify({ authenticated: true, csrfToken: "csrf" }),
      Date.now() + 60000,
    );
  const upload = async (rows: any[]) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      "Sheet",
    );
    const data = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    const payload = Buffer.concat([
      Buffer.from(
        '--BOUND\r\nContent-Disposition: form-data; name="file"; filename="data.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n',
      ),
      data,
      Buffer.from("\r\n--BOUND--\r\n"),
    ]);
    return app.inject({
      method: "POST",
      url: "/api/import",
      headers: {
        cookie: "omnimail=session",
        "x-csrf-token": "csrf",
        "content-type": "multipart/form-data; boundary=BOUND",
      },
      payload,
    });
  };
  try {
    const res = await upload([
      ["name", "receiver"],
      ["Test", "scylz12@nottingham.edu.cn"],
    ]);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().columns, ["name", "receiver"]);
    assert.equal(res.json().rows[0].receiver, "scylz12@nottingham.edu.cn");
    assert.equal((await upload([["constructor"], ["x"]])).statusCode, 400);
    assert.equal(
      (await upload([["name"], ...Array.from({ length: 1001 }, () => ["x"])]))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
