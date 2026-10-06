---
name: recipient-repair
description: Clean malformed or duplicate recipient addresses in OmniMail drafts, replace known incorrect addresses, exclude selected batch rows, or undo a repair. Does not verify mailbox existence or delivery.
---

# Recipient repair

Read `get_current_draft`, `get_batch_schema` and `validate_draft` to establish the active kind, mapping and revision. Use `repair_current_draft` with `preview: true` to inspect effects without applying them, then `preview: false` when the user requests cleanup. Existing authorization to fix the list covers deterministic cleanup; do not ask separately for every row. Exclude rows only when the user requests their exclusion, and replace addresses only with replacements the user provided.

The repair normalizes full-width ASCII, surrounding whitespace, separators and domain casing; it compares duplicates case-insensitively. It preserves the first primary email target and removes later duplicates, including duplicate targets mixed with other valid recipients in a cell. Later rows are removed only when their targets are wholly duplicate or explicitly excluded. Repeated copy recipients across separate messages and attendees across separate calendar events can be intentional and must remain.

Unknown invalid addresses remain unresolved. Do not guess local parts or domain spelling. Format validation cannot establish that a mailbox is active or diagnose a real bounce; describe that limit and use supplied bounce evidence only when available. Complex recipient expressions unsupported by the deterministic repair remain for manual editing. Never apply a cleanup to subject or HTML text.

Use `get_batch_row` only for relevant rows; repair reports expose a bounded subset of changed recipient cells rather than full private data. Re-read the revision before any later mutation. `undo_current_draft_repair` restores recipients and removed rows, retaining later body/conversation edits, and refuses to overwrite subsequent recipient or batch changes. Repair, saving and undo never queue or send. Finish with actual counts, unresolved issues and the human-review requirement.
