# OmniMail frontend

Vue 3 + TypeScript + Vite + Tailwind 4. shadcn-vue CLI generated the button, input, card, dialog, tabs, textarea and select components in `src/components/ui` (actual `npx shadcn-vue@latest add ... --yes` execution).

```sh
npm --prefix frontend install
npm --prefix frontend run dev
npm --prefix frontend run build
```

Development proxies `/api` and `/mcp` to `http://localhost:3000`; production expects same-origin API and cookie sessions. Adjust only `vite.config.ts` if the backend development port differs. WebAuthn requires HTTPS or localhost.

TinyMCE is bundled from npm under `license_key: 'gpl'`, loaded on demand, with locally imported icons, theme, model, plugins and CSS. No cloud script or API key is used. Review GPL obligations when distributing. The source editor is always available; preview uses sandbox + CSP blocking scripts and remote content. External preview images intentionally do not load.

All displayed records and metrics come from API responses. No demo mode or fabricated send success is shipped. `accepted` means the webhook/interface accepted the request, never proof of delivery. Calendar datetime-local values are Beijing wall time without a Z suffix. Tasks are created as drafts; only an explicit confirmation queues execution. Tests use the same confirmation path and never preset recipients.

AI receives the current draft and redacted row samples; imported rows are sent intact only to the task API. Credentials are not placed in local/session storage. MCP keys are displayed once and erased when navigating away; MCP tools bypass human confirmation, with a visible warning.

QA used intercepted in-memory API fixtures only (not production data): 360/768/1440 widths across all five pages, no horizontal overflow; keyboard focus and reduced-motion verified; TinyMCE mounted successfully. Real passkey ceremonies, provider calls, imports and backend persistence require integration QA. No actual mail or calendar operation was performed.
