<script setup lang="ts">
import { useMessages, message, isDefaultDraftTitle } from "@/lib/i18n";
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import {
  Plus,
  Search,
  Mail,
  CalendarDays,
  Sparkles,
  Upload,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  ArrowUp,
  ShieldCheck,
  Save,
  Eye,
  Send,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Trash2,
} from "lucide-vue-next";
import AppCheckbox from "./ui/AppCheckbox.vue";
import type {
  RepairReport,
  RepairOptions,
} from "../../../server/recipientRepair";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import AppSelect from "./ui/AppSelect.vue";
import HtmlEditor from "./HtmlEditor.vue";
import TestEmailDialog from "./TestEmailDialog.vue";
import type { TestEmailContent } from "@/lib/testEmail";
import RecipientInput from "./RecipientInput.vue";
import FieldInput from "./FieldInput.vue";
import AgentDialog from "./AgentDialog.vue";
import { useFeedback, notify } from "@/lib/notifications";
import {
  api,
  ApiError,
  idPath,
  type Kind,
  type Payload,
  type Message,
  type Template,
  type Task,
  type ServerDraft,
  type DraftContent,
} from "@/lib/api";
import {
  applyDraftSuggestion,
  type AgentAttachment,
  type AgentWorkspace,
} from "@/lib/agent";
import {
  fieldsIn,
  mergeIssues,
  renderFields,
  recommendedEmailColumn,
  type DataRow,
} from "@/lib/mailMerge";

import { createDraftSync, type SyncedDraft } from "@/lib/draftSync";

const copy = useMessages("workspaceView");
const tokenLabel = (field: string) => `{{${field}}}`;
const eventLabels = computed<Record<string, string>>(() => ({
  requiredAttendees: copy.value.requiredAttendees,
  optionalAttendees: copy.value.optionalAttendees,
  start: copy.value.startBeijingTime,
  end: copy.value.endBeijingTime,
  location: copy.value.location,
}));
const props = defineProps<{
  templates: Template[];
  tasks: Task[];

  dark: boolean;
  visible: boolean;
  locked: boolean;
}>();
const emit = defineEmits<{
  review: [Task];
  saved: [];
  settings: [];
  expired: [];
  busy: [boolean];
  template: [Kind, Payload];
}>();
interface Proposal {
  message: string;
  kind: Kind;
  payload: Payload;
  mapping?: Record<string, string>;
  workspace?: AgentWorkspace;
  workspaceChanged?: boolean;
  reviewTaskId?: string;
  hasSuggestion?: boolean;
}
interface Draft extends SyncedDraft {
  loaded: boolean;
  legacyItems: Payload[];
  legacyIndex: number;
  legacyNotice: boolean;
  id: string;
  revision: number;
  title: string;
  kind: Kind;
  payload: Payload;
  templateId: string;
  rows: DataRow[];
  columns: string[];
  fileName: string;
  recipientColumn: string;
  manualTo: string;
  mapping: Record<string, string>;
  conversation: Message[];
  attachments: AgentAttachment[];
  message: string;
  proposal?: Proposal;
  suggestionContext?: Payload;
  suggestionSnapshot?: string;
  saved?: Task;
  savedSnapshot?: string;
  mergeOpen: boolean;
  sample: number;
}
function blank(kind: Kind): Draft {
  return {
    id: crypto.randomUUID(),
    revision: 0,
    serverRevision: 0,
    serverSnapshot: "",
    syncState: "pending",
    syncError: "",
    loaded: true,
    legacyItems: [],
    legacyIndex: 0,
    legacyNotice: false,
    title:
      kind === "email" ? copy.value.untitledEmail : copy.value.untitledEvent,
    kind,
    payload:
      kind === "email"
        ? { to: "", cc: "", bcc: "", subject: "", html: "" }
        : {
            subject: "",
            html: "",
            start: "",
            end: "",
            requiredAttendees: "",
            optionalAttendees: "",
            location: "",
          },
    templateId: "none",
    rows: [],
    columns: [],
    fileName: "",
    recipientColumn: "",
    manualTo: "",
    mapping: {},
    conversation: [],
    attachments: [],
    message: "",
    mergeOpen: false,
    sample: 0,
  };
}
const drafts = ref<Draft[]>([blank("email")]);
watch(copy, () => {
  for (const item of drafts.value) {
    if (isDefaultDraftTitle(item.title))
      item.title =
        item.kind === "email"
          ? copy.value.untitledEmail
          : copy.value.untitledEvent;
  }
});
const activeId = ref(drafts.value[0]!.id);
const draft = computed(
  () =>
    drafts.value.find((item) => item.id === activeId.value) || drafts.value[0]!,
);
const search = ref(""),
  activity = ref(""),
  error = ref(""),
  success = ref(""),
  agentError = ref("");
const agentOpen = ref(false),
  ccOpen = ref(false),
  bccOpen = ref(false),
  optionalAttendeesOpen = ref(false),
  applyTemplateOpen = ref(false),
  clearOpen = ref(false),
  replaceOpen = ref(false);
const draftsReady = ref(false);
const draftLoadError = ref("");
const busy = computed(
  () => !draftsReady.value || !!activity.value || props.locked,
);
const mergeOpen = computed({
  get: () => props.visible && draft.value.mergeOpen,
  set: (open: boolean) => {
    if (!busy.value) draft.value.mergeOpen = open;
  },
});
function openMerge() {
  if (busy.value) return;
  agentOpen.value = false;
  draft.value.mergeOpen = true;
}
function requestImport() {
  if (busy.value) return;
  if (draft.value.rows.length) replaceOpen.value = true;
  else fileInput.value?.click();
}
function confirmReplace() {
  if (busy.value) return;
  replaceOpen.value = false;
  fileInput.value?.click();
}
const testEmailOpen = ref(false);
const testEmailContent = ref<TestEmailContent>();
function openTestEmail() {
  if (busy.value || draft.value.kind !== "email") return;
  const target = draft.value;
  testEmailContent.value = {
    subject: target.payload.subject,
    html: target.payload.html,
    row: { ...(target.rows[target.sample] || {}) },
    mapping: { ...target.mapping },
    sample: target.rows.length ? target.sample : undefined,
  };
  testEmailOpen.value = true;
}
const pendingDeleteId = ref<string>();
const pendingDeleteDraft = computed(() =>
  drafts.value.find((item) => item.id === pendingDeleteId.value),
);
const deleteDraftOpen = computed({
  get: () => !!pendingDeleteDraft.value,
  set: (open: boolean) => {
    if (!open) pendingDeleteId.value = undefined;
  },
});
useFeedback({
  error,
  success,
  pending: () =>
    activity.value && activity.value !== "agent"
      ? copy.value.activities[
          activity.value as keyof typeof copy.value.activities
        ] || copy.value.activities.other
      : "",
});
useFeedback({
  error: agentError,
  errorAction: () => ({
    label: copy.value.checkAISettings,
    run: () => {
      agentOpen.value = false;
      emit("settings");
    },
  }),
});
const fileInput = ref<HTMLInputElement>();
const dataPage = ref(0),
  problemOnly = ref(false),
  dataOpen = ref(false),
  mappingOpen = ref(false);
const visibleDrafts = computed(() =>
  drafts.value.filter((item) =>
    item.title.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const templateOptions = computed(() => [
  {
    value: "none",
    label: copy.value.noTemplateFreeWriting,
  },
  ...props.templates
    .filter((item) => item.kind === draft.value.kind)
    .map((item) => ({
      value: item.id,
      label: `${item.name} · v${item.version}`,
    })),
]);
const issues = computed(() =>
  mergeIssues(
    draft.value.kind,
    draft.value.payload,
    draft.value.rows,
    draft.value.mapping,
  ),
);
const placeholders = computed(() => fieldsIn(draft.value.payload));
const insertFields = computed(() => [
  ...new Set([...draft.value.columns, ...placeholders.value]),
]);
const fieldTarget = ref("html");
const payloadInputs = new Map<
  string,
  { insert: (field: string) => Promise<void> }
>();
const fieldTargets = computed(() => {
  const labels: Record<string, string> = {
    to: "To",
    cc: "CC",
    bcc: "BCC",
    subject: copy.value.subject,
    html: copy.value.body,
    ...eventLabels.value,
  };
  const fields =
    draft.value.kind === "email"
      ? ["to", "cc", "bcc", "subject", "html"]
      : [
          "requiredAttendees",
          "optionalAttendees",
          "subject",
          "start",
          "end",
          "location",
          "html",
        ];
  return fields.map((value) => ({
    value,
    label: labels[value]!,
    disabled:
      !!draft.value.rows.length &&
      !draft.value.recipientColumn &&
      (value === "to" || value === "requiredAttendees"),
  }));
});
function setPayloadInput(field: string, instance: unknown) {
  if (instance)
    payloadInputs.set(
      field,
      instance as { insert: (field: string) => Promise<void> },
    );
  else payloadInputs.delete(field);
}
function rememberField(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLElement)) return;
  if (
    input instanceof HTMLInputElement ||
    input instanceof HTMLTextAreaElement
  ) {
    if (input.readOnly || input.matches(":disabled")) return;
  } else if (!input.isContentEditable) return;
  const field = input.closest<HTMLElement>("[data-payload-field]")?.dataset
    .payloadField;
  if (
    !field ||
    !fieldTargets.value.some(
      (option) => option.value === field && !option.disabled,
    )
  )
    return;
  fieldTarget.value = field;
}
async function insertPayloadField(field: string) {
  if (busy.value) return;
  const target = fieldTarget.value;
  if (
    !fieldTargets.value.some(
      (option) => option.value === target && !option.disabled,
    )
  )
    return;
  if (target === "cc") ccOpen.value = true;
  if (target === "bcc") bccOpen.value = true;
  if (target === "optionalAttendees") optionalAttendeesOpen.value = true;
  await nextTick();
  await payloadInputs.get(target)?.insert(field);
}
const suggestion = computed(() => recommendedEmailColumn(draft.value.columns));
const columnOptions = computed(() =>
  draft.value.columns.map((column) => ({ value: column, label: column })),
);
const pageRows = computed(() =>
  draft.value.rows
    .map((row, index) => ({ row, index }))
    .filter(
      (entry) =>
        !problemOnly.value ||
        issues.value.some((issue) => issue.row === entry.index + 1),
    ),
);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(pageRows.value.length / 5)),
);
const displayedRows = computed(() =>
  pageRows.value.slice(dataPage.value * 5, dataPage.value * 5 + 5),
);
const sampleOptions = computed(() =>
  draft.value.rows.map((row, index) => ({
    value: String(index),
    label: `${copy.value.row} ${index + 1} · ${String(row[draft.value.recipientColumn] || Object.values(row)[0] || "")}`,
  })),
);
const selectedSample = computed({
  get: () => String(draft.value.sample),
  set: (value) => (draft.value.sample = Number(value)),
});
const previewHtml = computed(() =>
  renderFields(
    draft.value.payload.html,
    draft.value.rows[draft.value.sample] || {},
    draft.value.mapping,
    true,
  ),
);
const previewSubject = computed(() =>
  renderFields(
    draft.value.payload.subject,
    draft.value.rows[draft.value.sample] || {},
    draft.value.mapping,
  ),
);
const snapshot = () =>
  JSON.stringify({
    kind: draft.value.kind,
    payload: draft.value.payload,
    rows: draft.value.rows,
    mapping: draft.value.mapping,
    templateId: draft.value.templateId,
  });
const selectedTemplate = ref("none");
watch(
  () => props.tasks,
  (tasks) => {
    for (const item of drafts.value) {
      const updated = tasks.find((task) => task.id === item.saved?.id);
      if (updated && item.saved) item.saved.status = updated.status;
    }
  },
);
watch(
  pageCount,
  (count) => (dataPage.value = Math.min(dataPage.value, count - 1)),
);
watch(placeholders, (fields) => {
  for (const field of fields)
    if (!draft.value.mapping[field] && draft.value.columns.includes(field))
      draft.value.mapping[field] = field;
});
watch(activity, (value) => emit("busy", !!value));
watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      agentOpen.value = false;
      draft.value.mergeOpen = false;
      clearOpen.value = false;
      replaceOpen.value = false;
    }
  },
);
watch(activeId, (current, previous) => {
  selectedRows.value = [];
  replacementFrom.value = "";
  replacementTo.value = "";
  repairPreview.value = undefined;
  try {
    localStorage.setItem("omnimail-active-draft", current);
  } catch {}
  const previousDraft = drafts.value.find((item) => item.id === previous);
  if (previousDraft) previousDraft.mergeOpen = false;
  clearOpen.value = false;
  replaceOpen.value = false;
  fieldTarget.value = "html";
  error.value = "";
  success.value = "";
  agentError.value = "";
  dataPage.value = 0;
  problemOnly.value = false;
  dataOpen.value = false;
  mappingOpen.value = false;
  selectedTemplate.value = draft.value.templateId;
  ccOpen.value = !!draft.value.payload.cc;
  bccOpen.value = !!draft.value.payload.bcc;
  optionalAttendeesOpen.value = !!draft.value.payload.optionalAttendees;
});
const selectedRows = ref<number[]>([]);
const replacementFrom = ref(""),
  replacementTo = ref("");
const repairPreview = ref<{
  id: string;
  revision: number;
  options: RepairOptions;
  report: RepairReport;
}>();
const repairConfirmOpen = computed({
  get: () => !!repairPreview.value,
  set: (open: boolean) => {
    if (!open && !busy.value) repairPreview.value = undefined;
  },
});
const canUndoRepair = computed(
  () =>
    draft.value.loaded &&
    !!draft.value.undoRevision &&
    draft.value.undoRevision === draft.value.serverRevision &&
    !sync.dirty(draft.value),
);
function adoptServerDraft(target: Draft, value: ServerDraft) {
  const merge = target.mergeOpen,
    sample = target.sample;
  Object.assign(target, restored(value), {
    mergeOpen: merge,
    sample: Math.min(sample, Math.max(0, value.rows.length - 1)),
    undoRevision: value.undoRevision,
  });
  selectedRows.value = [];
}
async function previewRepair(options: RepairOptions = {}) {
  await run("repair", async () => {
    const target = draft.value;
    await sync.flush(target);
    const result = await api<{ report: RepairReport }>(
      "/drafts/" + idPath(target.id) + "/repair",
      "POST",
      { expectedRevision: target.serverRevision, preview: true, ...options },
    );
    repairPreview.value = {
      id: target.id,
      revision: target.serverRevision,
      options,
      report: result.report,
    };
  });
}
async function applyRepair() {
  if (!repairPreview.value) return;
  const preview = repairPreview.value;
  await run("repair", async () => {
    const target = drafts.value.find((item) => item.id === preview.id)!;
    const result = await api<{ draft: ServerDraft; report: RepairReport }>(
      "/drafts/" + idPath(preview.id) + "/repair",
      "POST",
      { expectedRevision: preview.revision, ...preview.options },
    );
    adoptServerDraft(target, result.draft);
    repairPreview.value = undefined;
    replacementFrom.value = "";
    replacementTo.value = "";
    success.value = message("workspaceView.repairComplete", {
      changed: result.report.changedCells,
      removed: result.report.removedRows,
      unresolved: result.report.unresolvedCount,
    });
  });
}
async function undoRepair() {
  await run("repair", async () => {
    const target = draft.value;
    await sync.flush(target);
    const value = await api<ServerDraft>(
      "/drafts/" + idPath(target.id) + "/undo-repair",
      "POST",
      { expectedRevision: target.serverRevision },
    );
    adoptServerDraft(target, value);
    success.value = copy.value.repairUndone;
  });
}
function selectRepairRow(index: number, checked: boolean) {
  selectedRows.value = checked
    ? [...new Set([...selectedRows.value, index])]
    : selectedRows.value.filter((item) => item !== index);
}
function draftContent(target: Draft): DraftContent {
  const legacyItems = target.legacyItems.map((payload, index) => ({
    ...(index === target.legacyIndex ? target.payload : payload),
  }));
  return {
    title: target.title,
    kind: target.kind,
    payload: { ...target.payload },
    templateId: target.templateId === "none" ? undefined : target.templateId,
    rows: structuredClone(JSON.parse(JSON.stringify(target.rows))),
    columns: [...target.columns],
    mapping: { ...target.mapping },
    recipientColumn: target.recipientColumn,
    manualTo: target.manualTo,
    fileName: target.fileName,
    conversation: JSON.parse(JSON.stringify(target.conversation.slice(-100))),
    attachments: JSON.parse(JSON.stringify(target.attachments)),
    message: target.message,
    legacyItems,
    legacyIndex: target.legacyIndex,
    legacyNotice: target.legacyNotice,
  } as DraftContent;
}
const sync = createDraftSync<Draft, DraftContent>({
  content: draftContent,
  write: (id, revision, content) =>
    api<ServerDraft>(
      revision ? "/drafts/" + idPath(id) : "/drafts",
      revision ? "PUT" : "POST",
      revision ? { expectedRevision: revision, content } : { id, content },
    ),
});
function restored(value: ServerDraft): Draft {
  const target = {
    ...blank(value.kind),
    ...value,
    payload: value.payload as Payload,
    legacyItems: value.legacyItems as Payload[],
    templateId: value.templateId || "none",
    loaded: true,
    serverRevision: value.revision,
    revision: value.revision,
    syncState: "saved" as const,
  };
  target.serverSnapshot = JSON.stringify(draftContent(target));
  return target;
}
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleSave(target: Draft) {
  if (
    !draftsReady.value ||
    !target.loaded ||
    target.syncState === "conflict" ||
    activity.value === "agent"
  )
    return;
  clearTimeout(saveTimers.get(target.id));
  if (!sync.dirty(target)) return;
  if (target.syncState !== "saving") target.syncState = "pending";
  saveTimers.set(
    target.id,
    setTimeout(() => {
      saveTimers.delete(target.id);
      void sync.flush(target).catch(() => {});
    }, 600),
  );
}
watch(
  () =>
    drafts.value.map((target) =>
      target.loaded ? JSON.stringify(draftContent(target)) : "",
    ),
  () => drafts.value.forEach(scheduleSave),
);
watch(activity, (value) => {
  if (!value) drafts.value.forEach(scheduleSave);
});
async function flushAll() {
  if (!draftsReady.value)
    throw Error(draftLoadError.value || copy.value.loadingDrafts);
  for (const target of drafts.value.filter((item) => item.loaded))
    await sync.flush(target);
}
async function loadDrafts() {
  draftLoadError.value = "";
  try {
    const summaries: {
      id: string;
      title: string;
      kind: Kind;
      revision: number;
      legacyNotice: boolean;
    }[] = [];
    let offset = 0;
    while (true) {
      const page = await api<{ drafts: typeof summaries; hasMore: boolean }>(
        "/drafts?offset=" + offset + "&limit=100",
      );
      summaries.push(...page.drafts);
      offset += page.drafts.length;
      if (!page.hasMore) break;
    }
    const existing = new Map(
      drafts.value
        .filter((item) => item.serverRevision)
        .map((item) => [item.id, item]),
    );
    const listed = summaries.map((summary) => {
      const local = existing.get(summary.id);
      if (local) return local;
      return {
        ...blank(summary.kind),
        id: summary.id,
        title: summary.title,
        serverRevision: summary.revision,
        legacyNotice: summary.legacyNotice,
        loaded: false,
        syncState: "saved" as const,
      };
    });
    if (!listed.length) {
      const created = blank("email");
      drafts.value = [created];
      activeId.value = created.id;
      await sync.flush(created);
    } else drafts.value = listed;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem("omnimail-active-draft");
    } catch {}
    const selected =
      drafts.value.find((item) => item.id === activeId.value) ||
      drafts.value.find((item) => item.id === remembered) ||
      drafts.value[0]!;
    if (!selected.loaded) {
      const value = await api<ServerDraft>("/drafts/" + idPath(selected.id));
      drafts.value.splice(drafts.value.indexOf(selected), 1, restored(value));
    }
    activeId.value = selected.id;
    draftsReady.value = true;
  } catch (cause) {
    draftLoadError.value =
      cause instanceof Error ? cause.message : String(cause);
    if (!drafts.value.length) drafts.value = [blank("email")];
    activeId.value = drafts.value[0]!.id;
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
  }
}
async function openWorkingDraft(id: string) {
  if (busy.value) return;
  await run("load", async () => {
    const target = drafts.value.find((item) => item.id === id);
    if (!target) return;
    if (!target.loaded)
      drafts.value.splice(
        drafts.value.indexOf(target),
        1,
        restored(await api<ServerDraft>("/drafts/" + idPath(id))),
      );
    activeId.value = id;
    try {
      localStorage.setItem("omnimail-active-draft", id);
    } catch {}
  });
}
async function openServerDraft(id: string) {
  const value = restored(await api<ServerDraft>("/drafts/" + idPath(id)));
  const local = drafts.value.find((item) => item.id === id);
  if (local && local.loaded && sync.dirty(local))
    throw Error(copy.value.localChangesNeedCopy);
  if (local) drafts.value.splice(drafts.value.indexOf(local), 1, value);
  else drafts.value.push(value);
  activeId.value = id;
  try {
    localStorage.setItem("omnimail-active-draft", id);
  } catch {}
}
async function reloadCurrentDraft() {
  const target = draft.value;
  await run("load", async () => {
    const latest = restored(
      await api<ServerDraft>("/drafts/" + idPath(target.id)),
    );
    clearTimeout(saveTimers.get(target.id));
    drafts.value.splice(drafts.value.indexOf(target), 1, latest);
    reloadDraftOpen.value = false;
  });
}
async function copyLocalDraft() {
  const target = draft.value;
  await run("save", async () => {
    const created = restored(
      await api<ServerDraft>("/drafts", "POST", {
        content: {
          ...draftContent(target),
          title: target.title + copy.value.copySuffix,
        },
      }),
    );
    drafts.value.push(created);
    // The copy now preserves every local edit; reopen the original from its latest server version.
    clearTimeout(saveTimers.get(target.id));
    target.loaded = false;
    target.syncState = "saved";
    target.syncError = "";
    activeId.value = created.id;
  });
}
function selectLegacyItem(value: string) {
  const target = draft.value;
  if (busy.value || !target.legacyItems[Number(value)]) return;
  target.legacyItems[target.legacyIndex] = { ...target.payload };
  target.legacyIndex = Number(value);
  target.payload = { ...target.legacyItems[target.legacyIndex]! };
}
const reloadDraftOpen = ref(false);
function beforeUnload(event: BeforeUnloadEvent) {
  if (
    drafts.value.some(
      (target) =>
        target.loaded && (sync.dirty(target) || target.syncState === "saving"),
    )
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => {
  document.addEventListener("keydown", shortcut);
  window.addEventListener("beforeunload", beforeUnload);
  void loadDrafts();
});
defineExpose({ flushAll, openServerDraft });
async function run(
  action: string,
  operation: () => Promise<void>,
  agent = false,
) {
  if (busy.value) return;
  activity.value = action;
  error.value = "";
  success.value = "";
  if (agent) agentError.value = "";
  try {
    await operation();
  } catch (cause) {
    const description = cause instanceof Error ? cause.message : String(cause);
    if (agent) agentError.value = description;
    else error.value = description;
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
  } finally {
    activity.value = "";
  }
}
async function addDraft(kind: Kind = "email", startAgent = true) {
  if (busy.value) return;
  await run("save", async () => {
    const created = blank(kind);
    await sync.flush(created);
    drafts.value.push(created);
    activeId.value = created.id;
    if (kind === "email" && startAgent) agentOpen.value = true;
  });
}
function changeKind(kind: string | number) {
  if (kind !== draft.value.kind) void addDraft(kind as Kind, kind === "email");
}
async function deleteWorkingDraft() {
  if (busy.value || !pendingDeleteDraft.value) return;
  await run("save", async () => {
    const removed = pendingDeleteDraft.value!;
    // A conflict never authorizes deletion of another window's latest edits.
    await api("/drafts/" + idPath(removed.id), "DELETE", {
      expectedRevision: removed.serverRevision,
    });
    clearTimeout(saveTimers.get(removed.id));
    const remaining = drafts.value.filter((item) => item.id !== removed.id);
    if (!remaining.length) {
      const created = blank(removed.kind);
      await sync.flush(created);
      remaining.push(created);
      search.value = "";
    }
    drafts.value = remaining;
    if (activeId.value === removed.id) {
      agentOpen.value = false;
      clearOpen.value = false;
      applyTemplateOpen.value = false;
      const next = remaining[0]!;
      if (!next.loaded)
        drafts.value[0] = restored(
          await api<ServerDraft>("/drafts/" + idPath(next.id)),
        );
      activeId.value = next.id;
    }
    pendingDeleteId.value = undefined;
  });
}
function requestTemplate() {
  if (selectedTemplate.value === "none") {
    draft.value.templateId = "none";
    return;
  }
  if (!draft.value.payload.subject && !draft.value.payload.html)
    applyTemplate();
  else applyTemplateOpen.value = true;
}
function applyTemplate() {
  const template = props.templates.find(
    (item) => item.id === selectedTemplate.value,
  );
  if (!template) return;
  draft.value.templateId = template.id;
  if (isDefaultDraftTitle(draft.value.title)) draft.value.title = template.name;
  draft.value.payload.subject = template.subject;
  draft.value.payload.html = template.html;
  draft.value.proposal = undefined;
  applyTemplateOpen.value = false;
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  const target = draft.value;
  await run("import", async () => {
    if (file.size > 5 * 1024 * 1024)
      throw Error(copy.value.fileMustNotExceed5MB);
    const form = new FormData();
    form.append("file", file);
    const data = await api<{
      columns: string[];
      rows: DataRow[];
      count: number;
    }>("/import", "POST", form);
    if (!data.rows.length) throw Error(copy.value.theFileContainsNoDataRows);
    const recipientKey = target.kind === "email" ? "to" : "requiredAttendees";
    if (!target.rows.length)
      target.manualTo = target.payload[recipientKey] || "";
    target.rows = data.rows;
    selectedRows.value = [];
    fieldTarget.value = "html";
    target.columns = data.columns;
    target.fileName = file.name;
    target.recipientColumn = "";
    target.mapping = {};
    target.sample = 0;
    target.mergeOpen = true;
    target.payload[recipientKey] = "";
    target.proposal = undefined;
    dataPage.value = 0;
    dataOpen.value = false;
    mappingOpen.value = fieldsIn(target.payload).some(
      (field) => !target.mapping[field],
    );
    for (const field of fieldsIn(target.payload))
      if (target.columns.includes(field)) target.mapping[field] = field;
    success.value = copy.value.importSuccess;
  });
}
function selectRecipient(column: string) {
  if (busy.value || !draft.value.columns.includes(column)) return;
  draft.value.recipientColumn = column;
  draft.value.payload[
    draft.value.kind === "email" ? "to" : "requiredAttendees"
  ] = `{{${column}}}`;
  draft.value.mapping[column] = column;
  success.value = message("workspaceView.emailColumnConfirmed", { column });
  error.value = "";
}
function clearData() {
  if (busy.value) return;
  const target = draft.value;
  target.rows = [];
  selectedRows.value = [];
  target.columns = [];
  target.fileName = "";
  target.recipientColumn = "";
  target.mapping = {};
  target.payload[target.kind === "email" ? "to" : "requiredAttendees"] =
    target.manualTo;
  target.sample = 0;
  target.proposal = undefined;
  success.value = copy.value.listRemovedRestoredASingleTask;
  error.value = "";
  clearOpen.value = false;
}
async function save(review = false) {
  await run("save", async () => {
    const target = draft.value;
    await sync.flush(target);
    if (!review) {
      success.value = copy.value.draftSavedToTheServerNotExecuted;
      return;
    }
    if (
      !target.legacyItems.length &&
      target.rows.length &&
      !target.recipientColumn
    ) {
      agentOpen.value = false;
      target.mergeOpen = true;
      throw Error(copy.value.confirmTheRecipientColumnFirst);
    }
    if (!target.legacyItems.length && issues.value.length) {
      agentOpen.value = false;
      target.mergeOpen = !!target.rows.length;
      throw Error(
        message("workspaceView.fixIssuesBeforeSaving", {
          count: issues.value.length,
        }),
      );
    }
    target.saved = await api<Task>(
      "/drafts/" + idPath(target.id) + "/review",
      "POST",
      { expectedRevision: target.serverRevision },
    );
    target.savedSnapshot = snapshot();
    emit("saved");
    emit("review", target.saved);
  });
}
let agentController: AbortController | undefined;
async function ask(instruction: string) {
  if (!instruction.trim() || busy.value) return;
  agentOpen.value = true;
  await run(
    "agent",
    async () => {
      const target = draft.value;
      await sync.flush(target);
      target.revision = target.serverRevision;
      const baseline = snapshot();
      const payload = target.payload;
      const suggestion =
        target.suggestionSnapshot === baseline
          ? target.suggestionContext
          : undefined;
      const conversation = target.conversation
        .filter(
          (entry) =>
            entry.status !== "pending" &&
            entry.status !== "error" &&
            entry.status !== "cancelled",
        )
        .slice(-50)
        .map(({ role, content }) => ({ role, content }));
      target.conversation.push(
        {
          role: "user",
          content: instruction,
          attachments: target.attachments.map(({ name, size }) => ({
            name,
            size,
          })),
        },
        {
          role: "assistant",
          content: "",
          status: "pending",
          stages: [],
          thinking: "",
        },
      );
      const turn = target.conversation[target.conversation.length - 1]!;
      target.message = "";
      agentController = new AbortController();
      target.proposal = undefined;
      let reviewTaskId: string | undefined;
      let openDraftId: string | undefined;
      let refresh = false;
      const applyWorkspace = (state: AgentWorkspace) => {
        if (state.draftId !== target.id || state.kind !== target.kind)
          throw Error(copy.value.invalidAiDraft);
        target.payload = { ...state.payload } as Payload;
        target.mapping = { ...state.mapping };
        target.recipientColumn = state.recipientColumn;
        target.templateId = state.templateId || "none";
        target.revision = state.revision;
        target.serverRevision = state.revision;
        target.suggestionContext = undefined;
        target.suggestionSnapshot = undefined;
        if (isDefaultDraftTitle(target.title) && state.payload.subject)
          target.title = state.payload.subject;
      };
      try {
        const proposal = await api<Proposal>(
          "/agent",
          "POST",
          {
            message: instruction,
            draftId: target.id,
            requestId: crypto.randomUUID(),
            revision: target.serverRevision,
            serverRevision: target.serverRevision,
            rows: target.rows,
            mapping: target.mapping,
            recipientColumn: target.recipientColumn,
            conversation,
            attachments: target.attachments,
            kind: target.kind,
            payload,
            suggestion,
            columns: target.columns,
            templateId:
              target.templateId === "none" ? undefined : target.templateId,
          },
          {
            signal: agentController.signal,
            onProgress: (event) => {
              if (event.type === "open-draft" && event.draftId)
                openDraftId = event.draftId;
              else if (event.type === "workspace" && event.workspace) {
                applyWorkspace(event.workspace);
                if (event.batch) {
                  target.rows = event.batch.rows;
                  target.columns = event.batch.columns;
                  target.fileName = event.batch.fileName;
                  target.manualTo = event.batch.manualTo;
                  target.undoRevision = event.batch.undoRevision;
                  target.sample = 0;
                  selectedRows.value = [];
                }
                reviewTaskId = undefined;
              } else if (event.type === "refresh") refresh = true;
              else if (event.type === "review" && event.taskId)
                reviewTaskId = event.taskId;
              else if (event.type === "tool" && event.tool) {
                turn.toolCalls ??= [];
                const existing = turn.toolCalls.find(
                  (call) => call.callId === event.tool!.callId,
                );
                if (existing) Object.assign(existing, event.tool);
                else turn.toolCalls.push(event.tool);
              } else if (event.type === "thinking" && event.text)
                turn.thinking =
                  (turn.thinking || "") +
                  event.text.slice(
                    0,
                    Math.max(0, 20000 - (turn.thinking?.length || 0)),
                  );
              else if (event.stage && !turn.stages!.includes(event.stage))
                turn.stages!.push(event.stage);
            },
          },
        );
        if (
          proposal.kind !== target.kind ||
          typeof proposal.payload?.subject !== "string" ||
          typeof proposal.payload?.html !== "string"
        )
          throw Error(copy.value.invalidAiDraft);
        if (proposal.workspaceChanged && proposal.workspace)
          applyWorkspace(proposal.workspace);
        reviewTaskId = proposal.reviewTaskId || reviewTaskId;
        target.proposal =
          proposal.hasSuggestion === false ? undefined : proposal;
        target.suggestionContext = target.proposal
          ? { ...proposal.payload }
          : undefined;
        target.suggestionSnapshot = baseline;
        turn.status = "complete";
        turn.content = proposal.message;
        if (openDraftId) {
          await sync.flush(target);
          await openServerDraft(openDraftId);
          agentOpen.value = false;
        } else if (reviewTaskId) {
          await sync.flush(target);
          // Final conversation and field edits must be persisted before the reviewed version is bound.
          const task = await api<Task>(
            "/drafts/" + idPath(target.id) + "/review",
            "POST",
            { expectedRevision: target.serverRevision },
          );
          target.saved = task;
          target.savedSnapshot = snapshot();
          target.proposal = undefined;
          agentOpen.value = false;
          emit("review", task);
        }
      } catch (error) {
        turn.status = agentController.signal.aborted ? "cancelled" : "error";
        turn.content =
          turn.status === "cancelled"
            ? copy.value.generationStoppedYourDraftIsUnchanged
            : error instanceof Error
              ? error.message
              : String(error);
        if (turn.status !== "cancelled") throw error;
      } finally {
        if (turn.status !== "complete")
          for (const call of turn.toolCalls || [])
            if (call.status === "running") {
              call.status = "error";
              call.summary = copy.value.agentInterrupted;
            }
        if (refresh) emit("saved");
        agentController = undefined;
      }
    },
    true,
  );
}
function applyProposal() {
  const target = draft.value,
    proposal = target.proposal;
  if (!proposal) return;
  const applied = applyDraftSuggestion(target, proposal, target.columns);
  target.payload = applied.payload as Payload;
  target.mapping = applied.mapping;
  if (isDefaultDraftTitle(target.title))
    target.title = proposal.payload.subject || target.title;
  target.templateId = "none";
  selectedTemplate.value = "none";
  target.proposal = undefined;
  agentOpen.value = false;
  success.value = copy.value.proposalApplied;
}
function quickAction(action: string) {
  if (busy.value) return;
  if (action === "check") {
    openMerge();
    if (draft.value.rows.length && !draft.value.recipientColumn)
      notify.warning(copy.value.confirmTheRecipientColumnFirst);
    else if (issues.value.length)
      notify.warning(
        message("workspaceView.issuesFound", { count: issues.value.length }),
      );
    else notify.success(copy.value.batchValidationSuccess);
  } else agentOpen.value = true;
}
async function reviewSaved(task: Task) {
  await run("load", async () =>
    emit("review", await api<Task>("/tasks/" + idPath(task.id))),
  );
}
function shortcut(event: KeyboardEvent) {
  if (
    props.visible &&
    !busy.value &&
    !mergeOpen.value &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k"
  ) {
    event.preventDefault();
    agentOpen.value = true;
  }
}
onUnmounted(() => {
  agentController?.abort();
  document.removeEventListener("keydown", shortcut);
  window.removeEventListener("beforeunload", beforeUnload);
  saveTimers.forEach(clearTimeout);
  emit("busy", false);
});

const deleteDraftDescriptionLabel = (name: string) =>
  message("workspaceView.deleteDraftDescription", { name });
</script>
<template>
  <div class="desk-workspace">
    <aside class="task-space">
      <div class="row between">
        <h2>{{ copy.taskSpace }}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="copy.newDraft"
          :disabled="busy"
          @click="addDraft()"
          ><Plus
        /></Button>
      </div>
      <div class="search-field">
        <Search :size="15" /><Input
          v-model="search"
          :placeholder="copy.searchDrafts"
          :aria-label="copy.searchDrafts"
        />
      </div>
      <div class="task-list">
        <p class="section-label">
          {{ copy.workingDrafts }} · {{ drafts.length }}
        </p>
        <div v-for="item in visibleDrafts" :key="item.id" class="working-draft">
          <Button
            variant="ghost"
            class="task-entry"
            :class="{ selected: item.id === activeId }"
            :disabled="busy"
            @click="openWorkingDraft(item.id)"
            ><span class="row between"
              ><strong>{{ item.title }}</strong
              ><Mail v-if="item.kind === 'email'" :size="14" /><CalendarDays
                v-else
                :size="14" /></span
            ><span class="muted text-xs">{{
              item.payload.subject || copy.readyToDraft
            }}</span
            ><span class="task-state"
              ><span class="status-dot"></span
              >{{ copy.syncStates[item.syncState]
              }}<span>{{
                item.rows.length
                  ? `${item.rows.length} ${copy.rows}`
                  : copy.singleTask
              }}</span></span
            ></Button
          >
          <Button
            variant="ghost"
            size="icon-sm"
            class="draft-delete"
            :disabled="busy"
            :aria-label="copy.deleteWorkingDraft + ': ' + item.title"
            :title="copy.deleteWorkingDraft"
            @click="pendingDeleteId = item.id"
            ><Trash2 :size="14"
          /></Button>
        </div>
        <div v-if="!visibleDrafts.length" class="empty">
          {{ copy.noMatchingDrafts }}
        </div>
      </div>
      <p class="task-space-note">
        <ShieldCheck :size="14" />{{ copy.serverDraftsHint }}
      </p>
    </aside>
    <div class="compose-region">
      <section class="compose-workspace">
        <div class="mobile-draft-switch">
          <AppSelect
            :model-value="activeId"
            @update:model-value="$event && openWorkingDraft($event)"
            :disabled="busy"
            :options="
              drafts.map((item) => ({ value: item.id, label: item.title }))
            "
            :aria-label="copy.switchDraft"
          /><Button
            variant="outline"
            size="icon"
            :disabled="busy"
            :aria-label="copy.newDraft"
            @click="addDraft()"
            ><Plus
          /></Button>
        </div>
        <div v-if="draftLoadError" class="draft-sync-alert" role="alert">
          <span>{{ draftLoadError }}</span
          ><Button variant="outline" @click="loadDrafts">{{
            copy.retrySave
          }}</Button>
        </div>
        <div
          v-if="draft.syncState === 'error' || draft.syncState === 'conflict'"
          class="draft-sync-alert"
          role="alert"
        >
          <span>{{ draft.syncError }}</span>
          <Button
            v-if="draft.syncState === 'error'"
            variant="outline"
            :disabled="busy"
            @click="save()"
            >{{ copy.retrySave }}</Button
          >
          <Button variant="outline" :disabled="busy" @click="copyLocalDraft">{{
            copy.saveLocalCopy
          }}</Button>
          <Button
            variant="outline"
            :disabled="busy"
            @click="reloadDraftOpen = true"
            >{{ copy.reloadServerDraft }}</Button
          >
        </div>
        <div v-if="draft.legacyNotice" class="draft-sync-alert">
          <span>{{ copy.legacyDraftWarning }}</span>
          <AppSelect
            v-if="draft.legacyItems.length"
            :model-value="String(draft.legacyIndex)"
            :options="
              draft.legacyItems.map((item, index) => ({
                value: String(index),
                label: `${copy.row} ${index + 1} · ${item.to || item.requiredAttendees || ''}`,
              }))
            "
            :disabled="busy"
            @update:model-value="$event && selectLegacyItem($event)"
          />
        </div>
        <div class="compose-heading">
          <div class="compose-identity">
            <Tabs
              class="compose-kind-tabs"
              :model-value="draft.kind"
              @update:model-value="changeKind"
            >
              <TabsList>
                <TabsTrigger value="email" :disabled="busy">{{
                  copy.email
                }}</TabsTrigger>
                <TabsTrigger value="event" :disabled="busy">{{
                  copy.event
                }}</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input
              v-model="draft.title"
              class="draft-title"
              :aria-label="copy.draftName"
              :disabled="busy"
            />
          </div>
          <div class="compose-actions">
            <Button
              variant="outline"
              aria-haspopup="dialog"
              :aria-expanded="mergeOpen"
              :disabled="busy || !!draft.legacyItems.length"
              @click="openMerge"
            >
              <FileSpreadsheet />{{
                draft.kind === "email" ? copy.mailMerge : copy.batchEvents
              }}
              <span
                v-if="draft.rows.length"
                class="badge"
                :class="{
                  'badge-warning': issues.length || !draft.recipientColumn,
                }"
              >
                {{ draft.rows.length }} {{ copy.rows }} ·
                {{
                  issues.length || !draft.recipientColumn
                    ? copy.needsReview
                    : copy.validated
                }}
              </span>
            </Button>
            <Button
              v-if="draft.kind === 'email'"
              variant="outline"
              :disabled="busy"
              @click="openTestEmail"
              ><Send />{{ copy.sendTestEmail }}</Button
            >
            <Button variant="outline" :disabled="busy" @click="save()">
              <Save />{{ copy.saveDraft }}
            </Button>
            <Button
              variant="ghost"
              :disabled="busy"
              @click="emit('template', draft.kind, { ...draft.payload })"
              >{{ copy.saveAsTemplate }}</Button
            >
            <Button :disabled="busy" @click="save(true)">
              <Eye />{{ copy.reviewConfirm }}
            </Button>
          </div>
        </div>

        <Card class="compose-card">
          <div class="compose-card-controls">
            <div class="compose-card-header">
              <span class="icon-label"
                ><Mail v-if="draft.kind === 'email'" :size="17" /><CalendarDays
                  v-else
                  :size="17"
                /><strong>{{
                  draft.kind === "email"
                    ? copy.emailEditor
                    : copy.calendarEditor
                }}</strong></span
              >
              <div class="template-picker">
                <AppSelect
                  v-model="selectedTemplate"
                  :disabled="busy"
                  :options="templateOptions"
                  :aria-label="copy.chooseTemplate"
                  @update:model-value="$event === 'none' && requestTemplate()"
                /><Button
                  variant="ghost"
                  size="sm"
                  :disabled="busy || selectedTemplate === 'none'"
                  @click="requestTemplate"
                  >{{ copy.apply }}</Button
                >
              </div>
            </div>
            <fieldset
              :key="draft.id"
              :disabled="busy"
              class="compose-fields"
              @focusin="rememberField"
            >
              <template v-if="draft.kind === 'email'"
                ><div class="compose-field">
                  <label for="compose-to">{{ copy.to }}</label
                  ><RecipientInput
                    :ref="(instance) => setPayloadInput('to', instance)"
                    data-payload-field="to"
                    id="compose-to"
                    v-model="draft.payload.to"
                    :label="copy.to"
                    :readonly="!!draft.rows.length && !draft.recipientColumn"
                    :placeholder="
                      draft.rows.length
                        ? copy.confirmRecipientColumn
                        : undefined
                    "
                  /><Button
                    variant="ghost"
                    size="xs"
                    @click="ccOpen = !ccOpen"
                    >{{ copy.cc }}</Button
                  ><Button
                    variant="ghost"
                    size="xs"
                    @click="bccOpen = !bccOpen"
                    >{{ copy.bcc }}</Button
                  >
                </div>
                <div v-if="ccOpen || draft.payload.cc" class="compose-field">
                  <label for="compose-cc">{{ copy.cc }}</label
                  ><RecipientInput
                    :ref="(instance) => setPayloadInput('cc', instance)"
                    data-payload-field="cc"
                    id="compose-cc"
                    v-model="draft.payload.cc"
                    :label="copy.cc"
                  />
                </div>
                <div v-if="bccOpen || draft.payload.bcc" class="compose-field">
                  <label for="compose-bcc">{{ copy.bcc }}</label
                  ><RecipientInput
                    :ref="(instance) => setPayloadInput('bcc', instance)"
                    data-payload-field="bcc"
                    id="compose-bcc"
                    v-model="draft.payload.bcc"
                    :label="copy.bcc"
                  /></div
              ></template>
              <div v-else class="event-fields">
                <div class="compose-field event-field">
                  <label for="compose-required-attendees">{{
                    eventLabels.requiredAttendees
                  }}</label>
                  <RecipientInput
                    :ref="
                      (instance) =>
                        setPayloadInput('requiredAttendees', instance)
                    "
                    data-payload-field="requiredAttendees"
                    id="compose-required-attendees"
                    v-model="draft.payload.requiredAttendees"
                    :label="eventLabels.requiredAttendees!"
                    :readonly="!!draft.rows.length && !draft.recipientColumn"
                    :placeholder="
                      draft.rows.length
                        ? copy.confirmRecipientColumn
                        : undefined
                    "
                  />
                  <Button
                    variant="ghost"
                    size="xs"
                    :disabled="busy"
                    :aria-expanded="
                      optionalAttendeesOpen || !!draft.payload.optionalAttendees
                    "
                    aria-controls="compose-optional-attendees-row"
                    @click="optionalAttendeesOpen = !optionalAttendeesOpen"
                    >{{ copy.optional }}</Button
                  >
                </div>
                <div
                  v-if="
                    optionalAttendeesOpen || draft.payload.optionalAttendees
                  "
                  id="compose-optional-attendees-row"
                  class="compose-field event-field"
                >
                  <label for="compose-optional-attendees">{{
                    eventLabels.optionalAttendees
                  }}</label>
                  <RecipientInput
                    :ref="
                      (instance) =>
                        setPayloadInput('optionalAttendees', instance)
                    "
                    data-payload-field="optionalAttendees"
                    id="compose-optional-attendees"
                    v-model="draft.payload.optionalAttendees"
                    :label="eventLabels.optionalAttendees!"
                  />
                </div>
                <div class="event-field event-range">
                  <span>{{ copy.start }}</span
                  ><FieldInput
                    :ref="(instance) => setPayloadInput('start', instance)"
                    data-payload-field="start"
                    v-model="draft.payload.start"
                    :aria-label="eventLabels.start"
                    :type="
                      draft.payload.start?.includes('{')
                        ? 'text'
                        : 'datetime-local'
                    "
                  /><span>{{ copy.end }}</span
                  ><FieldInput
                    :ref="(instance) => setPayloadInput('end', instance)"
                    data-payload-field="end"
                    v-model="draft.payload.end"
                    :aria-label="eventLabels.end"
                    :type="
                      draft.payload.end?.includes('{')
                        ? 'text'
                        : 'datetime-local'
                    "
                  />
                </div>
                <label class="event-field"
                  ><span>{{ eventLabels.location }}</span
                  ><FieldInput
                    :ref="(instance) => setPayloadInput('location', instance)"
                    data-payload-field="location"
                    v-model="draft.payload.location"
                    :aria-label="eventLabels.location"
                    type="text"
                /></label>
              </div>
              <div class="compose-field">
                <label for="compose-subject">{{ copy.subject }}</label
                ><FieldInput
                  :ref="(instance) => setPayloadInput('subject', instance)"
                  data-payload-field="subject"
                  id="compose-subject"
                  v-model="draft.payload.subject"
                  :placeholder="copy.giveThisDraftAClearSubject"
                />
              </div>
            </fieldset>
          </div>
          <HtmlEditor
            v-for="editorDraft in [draft]"
            :key="editorDraft.id"
            v-model="editorDraft.payload.html"
            fill
            :dark="dark"
            :disabled="busy"
            :fields="insertFields"
            v-model:field-target="fieldTarget"
            :field-targets="fieldTargets"
            @insert-field="insertPayloadField"
            :preview-html="previewHtml"
            :preview-subject="previewSubject"
            :preview-sample="draft.rows.length ? draft.sample : undefined"
            @agent="agentOpen = true"
          />
          <div class="editor-status">
            <span>{{ copy.serverDraftsHint }}</span
            ><span role="status" aria-live="polite">{{
              !draftsReady
                ? copy.loadingDrafts
                : copy.syncStates[draft.syncState]
            }}</span>
          </div>
        </Card>
      </section>
      <div class="agent-launch-anchor">
        <Button
          variant="secondary"
          class="agent-launch"
          :disabled="busy"
          :aria-label="copy.openOmniAgentToDraftOrRevise"
          aria-keyshortcuts="Meta+K Control+K"
          @click="agentOpen = true"
        >
          <span class="agent-emblem"><Sparkles /></span>
          <strong class="agent-launch-label">{{ copy.omniAgent }}</strong>
          <span class="agent-launch-details" aria-hidden="true">
            <span class="agent-launch-details-content">
              <small>{{ copy.describeGoalsOrganizeContentCheckFields }}</small>
              <kbd>{{ copy.commandCtrlK }}</kbd>
            </span>
          </span>
        </Button>
      </div>
    </div>
    <aside class="agent-sidebar">
      <div class="agent-heading">
        <span class="agent-emblem"><Sparkles :size="22" /></span>
        <div>
          <h2>{{ copy.omniMailAgent }}</h2>
          <p>{{ copy.yourDraftingPartner }}</p>
        </div>
      </div>
      <div class="agent-context">
        <strong>{{ draft.title }}</strong
        ><span
          >{{ draft.kind === "email" ? copy.emailDraft : copy.eventDraft }}
          ·
          {{
            draft.rows.length
              ? `${draft.rows.length} ${copy.rows}`
              : copy.singleTask
          }}</span
        ><span
          >{{ placeholders.length }} {{ copy.dynamicFields }} ·
          {{ copy.humanApprovalRequired }}</span
        >
      </div>
      <div class="agent-chat">
        <div
          v-for="(entry, index) in draft.conversation"
          :key="index"
          class="agent-message"
          :class="{ user: entry.role === 'user' }"
        >
          <small>{{ entry.role === "user" ? copy.you : copy.agentName }}</small>
          <p>{{ entry.content }}</p>
        </div>
      </div>
      <div class="agent-quick-actions">
        <Button
          variant="outline"
          size="xs"
          :disabled="busy"
          @click="quickAction('draft')"
          >{{ copy.draftWithMe }}</Button
        ><Button
          variant="outline"
          size="xs"
          :disabled="busy"
          @click="quickAction('check')"
          >{{ copy.checkMerge }}</Button
        >
      </div>
      <Button variant="secondary" :disabled="busy" @click="agentOpen = true"
        ><Sparkles :size="16" />{{ copy.openChatAttachFiles }}</Button
      >

      <Button
        v-if="draft.proposal"
        variant="secondary"
        :disabled="busy"
        @click="agentOpen = true"
        >{{ copy.reviewPendingSuggestion }}</Button
      >
      <p class="agent-boundary">
        {{ copy.aiPrivacyHint }}
      </p>
      <div class="task-inspector">
        <h3>{{ copy.taskContext }}</h3>
        <dl>
          <div>
            <dt>{{ copy.template }}</dt>
            <dd>
              {{
                templates.find((item) => item.id === draft.templateId)?.name ||
                copy.none
              }}
            </dd>
          </div>
          <div>
            <dt>{{ copy.itemsToComplete }}</dt>
            <dd>{{ issues.length }}</dd>
          </div>
          <div>
            <dt>{{ copy.saveStatus }}</dt>
            <dd>
              {{ copy.syncStates[draft.syncState] }}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
    <TestEmailDialog
      v-model:open="testEmailOpen"
      :content="testEmailContent"
      :dark="dark"
      @saved="emit('saved')"
      @expired="emit('expired')"
    />
    <AgentDialog
      :key="draft.id"
      v-model:open="agentOpen"
      :blank="!draft.payload.html.trim()"
      :kind="draft.kind"
      :busy="busy"
      :title="draft.title"
      v-model:message="draft.message"
      v-model:attachments="draft.attachments"
      :conversation="draft.conversation"
      :proposal="draft.proposal"
      @request="ask"
      @cancel="agentController?.abort()"
      @invalidate="draft.proposal = undefined"
      @apply="applyProposal"
      @settings="
        agentOpen = false;
        emit('settings');
      "
    />
    <Dialog v-model:open="deleteDraftOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ copy.deleteWorkingDraft2 }}</DialogTitle>
          <DialogDescription>
            {{ deleteDraftDescriptionLabel(pendingDeleteDraft?.title || "") }}
          </DialogDescription>
        </DialogHeader>
        <div class="actions">
          <Button variant="outline" @click="deleteDraftOpen = false">{{
            copy.cancel
          }}</Button>
          <Button
            variant="destructive"
            :disabled="busy"
            @click="deleteWorkingDraft"
            >{{ copy.deleteDraft }}</Button
          >
        </div>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="reloadDraftOpen">
      <DialogContent
        ><DialogHeader
          ><DialogTitle>{{ copy.reloadServerDraft }}</DialogTitle
          ><DialogDescription>{{
            copy.reloadDraftWarning
          }}</DialogDescription></DialogHeader
        >
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="reloadDraftOpen = false"
            >{{ copy.cancel }}</Button
          ><Button :disabled="busy" @click="reloadCurrentDraft">{{
            copy.reloadServerDraft
          }}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="applyTemplateOpen"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{ copy.applyTemplate }}</DialogTitle
          ><DialogDescription>{{
            copy.applyTemplateWarning
          }}</DialogDescription></DialogHeader
        >
        <div class="actions">
          <Button variant="outline" @click="applyTemplateOpen = false">{{
            copy.keepContent
          }}</Button
          ><Button @click="applyTemplate">{{ copy.applyTemplate2 }}</Button>
        </div></DialogContent
      ></Dialog
    >
    <Dialog v-model:open="mergeOpen">
      <DialogContent
        class="merge-dialog"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
      >
        <DialogHeader>
          <DialogTitle>{{
            draft.kind === "email" ? copy.mailMerge : copy.batchEvents
          }}</DialogTitle>
          <DialogDescription>{{ copy.mergeDialogHelp }}</DialogDescription>
        </DialogHeader>
        <div class="merge-dialog-scroll" :aria-busy="activity === 'import'">
          <div class="merge-summary">
            <span v-if="draft.rows.length" class="merge-file-name"
              >{{ draft.fileName }} · {{ draft.rows.length }}
              {{ copy.rows }}</span
            >
            <span
              v-if="draft.rows.length"
              class="badge"
              :class="{
                'badge-warning': issues.length || !draft.recipientColumn,
              }"
              >{{
                issues.length || !draft.recipientColumn
                  ? copy.needsReview
                  : copy.validated
              }}</span
            >
            <Button
              variant="outline"
              size="sm"
              :disabled="busy"
              @click="requestImport"
            >
              <Upload />{{
                draft.rows.length ? copy.replaceList : copy.importList
              }}
            </Button>
            <Button
              v-if="draft.rows.length"
              variant="ghost"
              size="sm"
              :disabled="busy"
              @click="clearOpen = true"
            >
              <Trash2 />{{ copy.clearList }}
            </Button>
            <span
              v-if="activity === 'import'"
              class="row muted text-xs"
              role="status"
              ><LoaderCircle class="animate-spin" :size="14" />{{
                copy.activities.import
              }}</span
            >
            <input
              ref="fileInput"
              type="file"
              accept=".csv,.xls,.xlsx"
              :aria-label="copy.importList"
              class="sr-only"
              tabindex="-1"
              @change="importFile"
            />
          </div>
          <div class="merge-body">
            <div
              v-if="draft.kind === 'email'"
              class="recipient-repair-controls"
            >
              <p class="muted text-xs">{{ copy.recipientRepairHelp }}</p>
              <div class="row wrap">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="
                    busy || (!!draft.rows.length && !draft.recipientColumn)
                  "
                  @click="previewRepair()"
                  ><ShieldCheck />{{ copy.repairRecipients }}</Button
                >
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="busy || !canUndoRepair"
                  @click="undoRepair"
                  >{{ copy.undoRecipientRepair }}</Button
                >
                <Button
                  v-if="selectedRows.length"
                  variant="outline"
                  size="sm"
                  :disabled="busy"
                  @click="previewRepair({ excludeRows: selectedRows })"
                  >{{ copy.excludeSelectedRows }} ·
                  {{ selectedRows.length }}</Button
                >
              </div>
              <div class="recipient-replacement">
                <Input
                  v-model="replacementFrom"
                  :disabled="busy"
                  :aria-label="copy.originalAddress"
                  :placeholder="copy.originalAddress"
                />
                <Input
                  v-model="replacementTo"
                  :disabled="busy"
                  :aria-label="copy.replacementAddress"
                  :placeholder="copy.replacementAddress"
                />
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="
                    busy ||
                    !replacementFrom.trim() ||
                    !replacementTo.trim() ||
                    (!!draft.rows.length && !draft.recipientColumn)
                  "
                  @click="
                    previewRepair({
                      replacements: { [replacementFrom]: replacementTo },
                    })
                  "
                  >{{ copy.replaceAddresses }}</Button
                >
              </div>
            </div>
            <p v-if="!draft.rows.length" class="muted text-sm">
              {{ copy.importHelp }}
            </p>
            <template v-else
              ><ol class="merge-steps">
                <li class="done">
                  <CheckCircle2 :size="13" />{{ copy.importList }}
                </li>
                <li :class="{ done: draft.recipientColumn }">
                  {{ copy.confirmRecipients }}
                </li>
                <li>{{ copy.insertFieldsValidate }}</li>
              </ol>
              <div class="recipient-mapping">
                <label class="field"
                  ><span>{{ copy.recipientColumnConfirmFirst }}</span
                  ><AppSelect
                    :model-value="draft.recipientColumn || undefined"
                    :options="columnOptions"
                    :placeholder="copy.selectEmailColumn"
                    :disabled="busy"
                    @update:model-value="selectRecipient($event!)" /></label
                ><Button
                  v-if="!draft.recipientColumn && suggestion"
                  variant="secondary"
                  size="sm"
                  :disabled="busy"
                  @click="selectRecipient(suggestion)"
                  >{{ copy.useDetectedColumn }}: {{ suggestion }}</Button
                >
              </div>
              <div class="merge-detail-toggles">
                <Button
                  variant="outline"
                  size="sm"
                  :aria-expanded="dataOpen"
                  @click="dataOpen = !dataOpen"
                  ><FileSpreadsheet />{{
                    dataOpen ? copy.hideData : copy.viewEditList
                  }}</Button
                ><Button
                  v-if="placeholders.length"
                  variant="ghost"
                  size="sm"
                  :aria-expanded="mappingOpen"
                  @click="mappingOpen = !mappingOpen"
                  >{{ copy.fieldMapping }} · {{ placeholders.length }}</Button
                >
              </div>
              <div
                v-if="placeholders.length && mappingOpen"
                class="mapping-grid"
              >
                <label v-for="field in placeholders" :key="field" class="field"
                  ><span>{{ tokenLabel(field) }}</span
                  ><AppSelect
                    v-model="draft.mapping[field]"
                    :options="columnOptions"
                    :placeholder="copy.mapToAColumn"
                    :disabled="busy || field === draft.recipientColumn"
                /></label>
              </div>
              <div v-if="issues.length" class="merge-validation">
                <AlertCircle :size="15" /><span
                  >{{ issues.length }} {{ copy.validationDetails }}</span
                ><Button
                  v-for="(issue, issueIndex) in issues.slice(0, 3)"
                  :key="issueIndex"
                  size="xs"
                  variant="ghost"
                  @click="
                    problemOnly = true;
                    dataOpen = true;
                    dataPage = 0;
                  "
                  >{{ issue.row ? `${copy.row} ${issue.row} · ` : ""
                  }}{{ issue.field }}: {{ issue.message }}</Button
                >
              </div>
              <div v-if="dataOpen" class="merge-table-scroll">
                <table class="data-table">
                  <caption class="sr-only">
                    {{
                      copy.mailMergeList
                    }}
                  </caption>
                  <thead>
                    <tr>
                      <th
                        v-if="draft.kind === 'email'"
                        class="repair-row-select"
                        scope="col"
                      >
                        {{ copy.selectRows }}
                      </th>
                      <th scope="col">{{ copy.row2 }}</th>
                      <th
                        v-for="column in draft.columns"
                        :key="column"
                        scope="col"
                      >
                        {{ column }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="entry in displayedRows"
                      :key="entry.index"
                      :class="{
                        'row-problem': issues.some(
                          (issue) => issue.row === entry.index + 1,
                        ),
                      }"
                    >
                      <td
                        v-if="draft.kind === 'email'"
                        class="repair-row-select"
                      >
                        <AppCheckbox
                          :model-value="selectedRows.includes(entry.index)"
                          :disabled="busy"
                          :aria-label="
                            message('workspaceView.selectRepairRow', {
                              row: entry.index + 1,
                            })
                          "
                          @update:model-value="
                            selectRepairRow(entry.index, $event)
                          "
                        />
                      </td>
                      <th scope="row">{{ entry.index + 1 }}</th>
                      <td v-for="column in draft.columns" :key="column">
                        <Input
                          :model-value="String(entry.row[column] ?? '')"
                          :aria-label="`${entry.index + 1} · ${column}`"
                          :disabled="busy"
                          @update:model-value="entry.row[column] = $event"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="dataOpen" class="row between merge-pagination">
                <Button
                  variant="ghost"
                  size="sm"
                  :class="{ 'text-primary': problemOnly }"
                  @click="
                    problemOnly = !problemOnly;
                    dataPage = 0;
                  "
                  >{{
                    problemOnly ? copy.showAll : copy.problemRowsOnly
                  }}</Button
                >
                <div class="row">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    :disabled="dataPage === 0"
                    :aria-label="copy.previousPage"
                    @click="dataPage--"
                    ><ChevronLeft /></Button
                  ><span class="muted text-xs"
                    >{{ dataPage + 1 }} / {{ pageCount }}</span
                  ><Button
                    variant="outline"
                    size="icon-sm"
                    :disabled="dataPage + 1 >= pageCount"
                    :aria-label="copy.nextPage"
                    @click="dataPage++"
                    ><ChevronRight
                  /></Button>
                </div>
              </div>
              <label class="field"
                ><span>{{ copy.personalizedPreviewSample }}</span
                ><AppSelect
                  v-model="selectedSample"
                  :options="sampleOptions"
                  :disabled="busy" /></label
            ></template>
          </div>
        </div>
        <div class="merge-dialog-footer">
          <span class="muted text-xs">{{ copy.mergeChangesRetained }}</span>
          <div class="actions">
            <Button
              variant="outline"
              :disabled="busy || !draft.rows.length"
              @click="quickAction('check')"
              ><ShieldCheck />{{ copy.validateBatch }}</Button
            >
            <Button :disabled="busy" @click="mergeOpen = false">{{
              copy.returnToEditor
            }}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="repairConfirmOpen">
      <DialogContent
        class="repair-confirm-dialog"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
      >
        <DialogHeader
          ><DialogTitle>{{ copy.recipientRepairPreview }}</DialogTitle
          ><DialogDescription>{{
            copy.recipientRepairWarning
          }}</DialogDescription></DialogHeader
        >
        <template v-if="repairPreview">
          <p>
            {{
              message("workspaceView.repairSummary", {
                changed: repairPreview.report.changedCells,
                duplicates: repairPreview.report.duplicateAddresses,
                removed: repairPreview.report.removedRows,
                unresolved: repairPreview.report.unresolvedCount,
              })
            }}
          </p>
          <p
            v-if="repairPreview.report.unsupportedFields.length"
            class="muted text-xs"
          >
            {{ copy.complexRecipientsNeedManualEdit }}
            {{ repairPreview.report.unsupportedFields.join(", ") }}
          </p>
          <div
            v-if="repairPreview.report.changes.length"
            class="repair-changes"
          >
            <div
              v-for="(change, index) in repairPreview.report.changes.slice(
                0,
                20,
              )"
              :key="index"
            >
              <strong
                >{{ change.row ? `${copy.row} ${change.row} · ` : ""
                }}{{ change.field }}</strong
              >
              <span
                >{{ change.before }} →
                {{ change.after || copy.rowRemoved }}</span
              >
            </div>
            <p
              v-if="repairPreview.report.changes.length > 20"
              class="muted text-xs"
            >
              {{ copy.showingFirstRepairChanges }}
            </p>
          </div>
          <p
            v-if="
              !repairPreview.report.changedCells &&
              !repairPreview.report.removedRows
            "
            class="muted"
          >
            {{ copy.nothingToRepair }}
          </p>
          <div class="actions">
            <Button
              variant="outline"
              :disabled="busy"
              @click="repairConfirmOpen = false"
              >{{ copy.cancel }}</Button
            >
            <Button
              :disabled="
                busy ||
                (!repairPreview.report.changedCells &&
                  !repairPreview.report.removedRows)
              "
              @click="applyRepair"
              >{{ copy.applyRecipientRepair }}</Button
            >
          </div>
        </template>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="replaceOpen">
      <DialogContent @interact-outside.prevent>
        <DialogHeader>
          <DialogTitle>{{ copy.replaceList }}</DialogTitle>
          <DialogDescription>{{ copy.replaceListWarning }}</DialogDescription>
        </DialogHeader>
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="replaceOpen = false"
            >{{ copy.cancel }}</Button
          >
          <Button :disabled="busy" @click="confirmReplace">{{
            copy.chooseReplacementList
          }}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="clearOpen"
      ><DialogContent @interact-outside.prevent
        ><DialogHeader
          ><DialogTitle>{{ copy.clearImportedData }}</DialogTitle
          ><DialogDescription>{{
            copy.clearListWarning
          }}</DialogDescription></DialogHeader
        >
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="clearOpen = false"
            >{{ copy.back }}</Button
          ><Button variant="destructive" :disabled="busy" @click="clearData">{{
            copy.clearList
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </div>
</template>
