import { z } from "zod";
import { id, type Store } from "./store.js";
import { serverMessage } from "./i18n.js";

export const templateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    kind: z.enum(["email", "event"]),
    subject: z.string().max(998).default(""),
    html: z.string().max(500000).default(""),
    fields: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^{}]+$/)
          .refine(
            (field) =>
              !["__proto__", "constructor", "prototype"].includes(field),
          ),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type Template = z.infer<typeof templateSchema> & {
  id: string;
  version: number;
  createdAt: string;
};

export function createTemplates(store: Store) {
  const { db } = store;
  const list = (): Template[] =>
    (
      db.prepare("SELECT value FROM templates ORDER BY rowid").all() as {
        value: string;
      }[]
    ).map((row) => JSON.parse(row.value));
  const get = (templateId: string): Template => {
    const row = db
      .prepare("SELECT value FROM templates WHERE id=?")
      .get(templateId) as { value: string } | undefined;
    if (!row) throw Error(serverMessage("app.templateNotFound"));
    return JSON.parse(row.value);
  };
  const checkVersion = (current: Template, expectedVersion?: number) => {
    if (expectedVersion !== undefined && expectedVersion !== current.version)
      throw Error(serverMessage("agentTools.versionConflict"));
  };
  const write = (
    body: unknown,
    templateId: string,
    version: number,
    source: string,
  ) => {
    const value: Template = {
      ...templateSchema.parse(body),
      id: templateId,
      version,
      createdAt: new Date().toISOString(),
    };
    db.prepare("INSERT OR REPLACE INTO templates VALUES (?,?)").run(
      templateId,
      JSON.stringify(value),
    );
    db.prepare("INSERT INTO template_versions VALUES (?,?,?)").run(
      templateId,
      version,
      JSON.stringify(value),
    );
    store.audit(`template.saved:${templateId}:${version}`, source);
    return value;
  };
  const create = (body: unknown, source = "web") =>
    db.transaction(() => write(body, id(), 1, source))();
  const update = (
    templateId: string,
    patch: unknown,
    expectedVersion?: number,
    source = "web",
  ) =>
    db.transaction(() => {
      const current = get(templateId);
      checkVersion(current, expectedVersion);
      const changes = templateSchema.partial().parse(patch);
      const {
        id: _id,
        version: _version,
        createdAt: _date,
        ...content
      } = current;
      return write(
        { ...content, ...changes },
        templateId,
        current.version + 1,
        source,
      );
    })();
  const versions = (templateId: string): Template[] => {
    get(templateId);
    return (
      db
        .prepare(
          "SELECT value FROM template_versions WHERE templateId=? ORDER BY version DESC",
        )
        .all(templateId) as { value: string }[]
    ).map((row) => JSON.parse(row.value));
  };
  const rollback = (
    templateId: string,
    version: number,
    expectedVersion?: number,
    source = "web",
  ) =>
    db.transaction(() => {
      const current = get(templateId);
      checkVersion(current, expectedVersion);
      const row = db
        .prepare(
          "SELECT value FROM template_versions WHERE templateId=? AND version=?",
        )
        .get(templateId, version) as { value: string } | undefined;
      if (!row) throw Error(serverMessage("app.versionNotFound"));
      const {
        id: _id,
        version: _version,
        createdAt: _date,
        ...content
      } = JSON.parse(row.value);
      return write(content, templateId, current.version + 1, source);
    })();
  const remove = (
    templateId: string,
    expectedVersion?: number,
    source = "web",
  ) =>
    db.transaction(() => {
      const current = get(templateId);
      checkVersion(current, expectedVersion);
      db.prepare("DELETE FROM templates WHERE id=?").run(templateId);
      store.audit(`template.deleted:${templateId}`, source);
      return { id: templateId, name: current.name, deleted: true };
    })();
  return { list, get, create, update, versions, rollback, remove };
}
