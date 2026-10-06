import test from "node:test";
import assert from "node:assert/strict";
import { createDraftSync, type SyncedDraft } from "../src/lib/draftSync.ts";
const target = () =>
  ({
    id: "draft",
    serverRevision: 0,
    serverSnapshot: "",
    syncState: "pending",
    syncError: "",
    text: "unfinished",
  }) as SyncedDraft & { text: string };
test("autosave serializes in-flight edits and flush waits until the latest text is persisted", async () => {
  const draft = target(),
    writes: { revision: number; text: string }[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const sync = createDraftSync({
    content: (item: typeof draft) => ({ text: item.text }),
    write: async (_id, revision, content) => {
      writes.push({ revision, text: content.text });
      if (writes.length === 1) await gate;
      return { revision: revision + 1 };
    },
  });
  const saving = sync.flush(draft);
  draft.text = "new edit during save";
  const next = sync.flush(draft);
  finish();
  await Promise.all([saving, next]);
  assert.deepEqual(writes, [
    { revision: 0, text: "unfinished" },
    { revision: 1, text: "new edit during save" },
  ]);
  assert.equal(draft.serverRevision, 2);
  assert.equal(draft.syncState, "saved");
  assert.equal(sync.dirty(draft), false);
});
test("conflicts preserve local content and version, never overwrite or silently retry", async () => {
  const draft = target();
  draft.serverRevision = 4;
  let calls = 0;
  const sync = createDraftSync({
    content: (item: typeof draft) => ({ text: item.text }),
    write: async () => {
      calls++;
      throw Object.assign(new Error("conflict"), { status: 409 });
    },
  });
  await assert.rejects(sync.flush(draft), /conflict/);
  assert.equal(draft.text, "unfinished");
  assert.equal(draft.serverRevision, 4);
  assert.equal(draft.syncState, "conflict");
  await assert.rejects(sync.flush(draft));
  assert.equal(calls, 1);
});
test("network failures remain dirty and an explicit retry saves without duplicating successful writes", async () => {
  const draft = target();
  let calls = 0;
  const sync = createDraftSync({
    content: (item: typeof draft) => ({ text: item.text }),
    write: async () => {
      if (++calls === 1) throw Error("offline");
      return { revision: 1 };
    },
  });
  await assert.rejects(sync.flush(draft));
  assert.equal(draft.syncState, "error");
  assert.equal(sync.dirty(draft), true);
  await sync.flush(draft);
  await sync.flush(draft);
  assert.equal(calls, 2);
  assert.equal(draft.syncState, "saved");
});
