---
name: server-drafts
description: Save, find, reopen and edit OmniMail server drafts, including incomplete drafts and legacy rendered batches. Use for continuing work on a saved draft or preparing it for human review.
---

# Server drafts

Use `list_server_drafts` to find a draft, then `get_server_draft` for its fields and revision. Use `open_server_draft` to reopen the same record in the editor; opening does not overwrite the current draft. Do not substitute an unrelated task or template for the requested draft.

For the active draft, read `get_current_draft` before `update_current_draft`. For another saved draft use `update_server_draft` with its latest `expectedRevision`. Patch only requested fields. A stale version means another window edited it: read the latest version and reassess the requested patch, rather than replaying an entire old document.

`save_draft` persists incomplete work; missing recipients, subject or body do not prevent saving. It does not create a send task. `request_execution_confirmation` validates the whole batch and creates a version-bound snapshot for human review. Any subsequent persisted draft edit invalidates that snapshot. Never claim that saving, review or webhook acceptance means delivery.

Batch summaries omit private rows. Read only relevant rows using `get_batch_row`. Legacy batch drafts preserve rendered items, not the original list or mappings: open them for individual editing in the UI; do not invent lost data or silently discard items. Existing task history remains immutable.
