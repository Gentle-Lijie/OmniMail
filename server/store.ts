import { serverMessage } from "./i18n.js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const id = () => randomBytes(16).toString("hex");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function createStore(path: string, secret: string) {
  if (!secret || secret.length < 32)
    throw new Error(
      serverMessage("store.aPPSECRETMustContainAtLeast32Characters"),
    );
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY,name TEXT NOT NULL,credential TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,value TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS template_versions (templateId TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(templateId,version));
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY,value TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS draft_repairs (draftId TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,value TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,value TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY,name TEXT NOT NULL,prefix TEXT NOT NULL,hash TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_operations (scope TEXT NOT NULL,operation TEXT NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(scope,operation));
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY,action TEXT NOT NULL,source TEXT NOT NULL,createdAt TEXT NOT NULL);
  `);
  const key = createHash("sha256").update(secret).digest();
  const encrypt = (s: string) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), data]
      .map((x) => x.toString("base64"))
      .join(".");
  };
  const decrypt = (s: string) => {
    const [iv, tag, data] = s.split(".").map((x) => Buffer.from(x, "base64"));
    const c = createDecipheriv("aes-256-gcm", key, iv);
    c.setAuthTag(tag);
    return Buffer.concat([c.update(data), c.final()]).toString();
  };
  const get = (k: string, fallback: any = null): any => {
    const row = db
      .prepare("SELECT value FROM config WHERE key=?")
      .get(k) as any;
    return row ? JSON.parse(row.value) : fallback;
  };
  const set = (k: string, v: any) =>
    db
      .prepare("INSERT OR REPLACE INTO config VALUES (?,?)")
      .run(k, JSON.stringify(v));
  const audit = (action: string, source = "web") =>
    db
      .prepare("INSERT INTO audit VALUES (?,?,?,?)")
      .run(id(), action, source, new Date().toISOString());
  return { db, get, set, encrypt, decrypt, audit };
}
export type Store = ReturnType<typeof createStore>;
