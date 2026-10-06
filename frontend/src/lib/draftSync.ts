// Serialize writes per draft, including edits made while a request is in flight.
export interface SyncedDraft {
  id: string;
  serverRevision: number;
  serverSnapshot: string;
  syncState: "pending" | "saving" | "saved" | "error" | "conflict";
  syncError: string;
  undoRevision?: number;
}
export function createDraftSync<T extends SyncedDraft, C>(options: {
  content: (draft: T) => C;
  write: (
    id: string,
    revision: number,
    content: C,
  ) => Promise<{ revision: number; undoRevision?: number }>;
}) {
  const pending = new Map<string, Promise<void>>();
  const dirty = (draft: T) =>
    !draft.serverRevision ||
    JSON.stringify(options.content(draft)) !== draft.serverSnapshot;
  async function flush(draft: T): Promise<void> {
    const previous = pending.get(draft.id);
    if (previous) {
      await previous;
      if (dirty(draft)) return flush(draft);
      return;
    }
    if (draft.syncState === "conflict") throw new Error(draft.syncError);
    const request = (async () => {
      while (dirty(draft)) {
        const content = options.content(draft),
          snapshot = JSON.stringify(content);
        draft.syncState = "saving";
        draft.syncError = "";
        try {
          const saved = await options.write(
            draft.id,
            draft.serverRevision,
            content,
          );
          draft.serverRevision = saved.revision;
          draft.undoRevision = saved.undoRevision;
          draft.serverSnapshot = snapshot;
        } catch (error) {
          draft.syncState =
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error.status === 409 || error.status === 404)
              ? "conflict"
              : "error";
          draft.syncError =
            error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
      draft.syncState = "saved";
    })();
    pending.set(draft.id, request);
    try {
      await request;
    } finally {
      if (pending.get(draft.id) === request) pending.delete(draft.id);
    }
  }
  return { dirty, flush };
}
