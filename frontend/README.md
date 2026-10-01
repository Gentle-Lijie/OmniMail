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

### Internationalization

Application copy lives in `src/locales/zh.json` and `src/locales/en.json`, grouped by component with stable semantic keys. Add matching keys and named parameters to both files. Escape literal vue-i18n syntax in messages (`{'{'}`, `{'}'}`, `{'@'}`, `{'|'}`); use `{name}` or `{count}` for interpolation.

Components resolve reactive copy in `<script setup>` with `const copy = useMessages("workspaceView")` and bind `copy.subject` in templates. Use `copy.value.subject` in script. Format parameterized messages with `message(key, values)` in script and expose the result or a label function to the template. Keep translation calls and source-language text out of templates; do not pass translators through props.

The selected language is saved locally and sent in `Accept-Language`. Server messages and model instructions live in `server/locales/zh.json` and `server/locales/en.json`; request language is isolated with `AsyncLocalStorage`. Task failures retain a message key so they can be translated for each reader. User-authored mail, templates, conversations, protocol identifiers, and data-column aliases retain their original content.

TinyMCE's Chinese language pack is stored as `src/locales/tinymce/zh_CN.json`, converted from the TinyMCE 7 [language pack](https://github.com/mklkj/tinymce-i18n/blob/master/langs7/zh_CN.js). The accompanying license records the upstream terms. The editor rebuilds on language changes while preserving its bound HTML.

Run `npm test` from the repository root to check catalog parity, interpolation, reactive copy, API language handling, and the template text conventions.
