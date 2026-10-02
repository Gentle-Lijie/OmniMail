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
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  ArrowUp,
  ShieldCheck,
  Save,
  Eye,
  X,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Trash2,
} from "lucide-vue-next";
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
} from "@/lib/api";
import type { AgentAttachment, AgentWorkspace } from "@/lib/agent";
import {
  fieldsIn,
  mappedRows,
  mergeIssues,
  renderFields,
  recommendedEmailColumn,
  type DataRow,
} from "@/lib/mailMerge";

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
interface Draft {
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
  suggestionContext?: Pick<Payload, "subject" | "html">;
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
const draft = computed(() =>
  drafts.value.find((item) => item.id === activeId.value)!,
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
  clearOpen = ref(false);
const busy = computed(() => !!activity.value || props.locked);
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
const savedCurrent = computed(() => draft.value.savedSnapshot === snapshot());
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
    if (!visible) agentOpen.value = false;
  },
);
watch(activeId, () => {
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
onMounted(() => {
  document.addEventListener("keydown", shortcut);
});
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
function addDraft(kind: Kind = "email", startAgent = true) {
  if (busy.value) return;
  const created = blank(kind);
  drafts.value.push(created);
  activeId.value = created.id;
  if (kind === "email" && startAgent) agentOpen.value = true;
}
function changeKind(kind: string | number) {
  if (kind !== draft.value.kind) addDraft(kind as Kind, kind === "email");
}
function deleteWorkingDraft() {
  if (busy.value || !pendingDeleteDraft.value) return;
  const removed = pendingDeleteDraft.value;
  const index = drafts.value.findIndex((item) => item.id === removed.id);
  const remaining = drafts.value.filter((item) => item.id !== removed.id);
  if (!remaining.length) {
    remaining.push(blank(removed.kind));
    search.value = "";
  }
  if (activeId.value === removed.id) {
    agentOpen.value = false;
    applyTemplateOpen.value = false;
    clearOpen.value = false;
    activeId.value = remaining[Math.min(index, remaining.length - 1)]!.id;
  }
  drafts.value = remaining;
  pendingDeleteId.value = undefined;
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
  if (!file) return;
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
    const target = draft.value;
    const recipientKey = target.kind === "email" ? "to" : "requiredAttendees";
    if (!target.rows.length)
      target.manualTo = target.payload[recipientKey] || "";
    target.rows = data.rows;
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
  input.value = "";
}
function selectRecipient(column: string) {
  draft.value.recipientColumn = column;
  draft.value.payload[
    draft.value.kind === "email" ? "to" : "requiredAttendees"
  ] = `{{${column}}}`;
  draft.value.mapping[column] = column;
  success.value = message("workspaceView.emailColumnConfirmed", { column });
  error.value = "";
}
function clearData() {
  const target = draft.value;
  target.rows = [];
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
    if (draft.value.rows.length && !draft.value.recipientColumn)
      throw Error(copy.value.confirmTheRecipientColumnFirst);
    if (issues.value.length) {
      draft.value.mergeOpen = !!draft.value.rows.length;
      throw Error(
        message("workspaceView.fixIssuesBeforeSaving", {
          count: issues.value.length,
        }),
      );
    }
    const target = draft.value;
    if (
      !savedCurrent.value ||
      !target.saved ||
      target.saved.status !== "draft"
    ) {
      const saved = await api<Task>("/tasks", "POST", {
        kind: target.kind,
        payload: target.payload,
        rows: target.rows.length
          ? mappedRows(target.rows, target.mapping)
          : undefined,
        templateId:
          target.templateId === "none" ? undefined : target.templateId,
        conversation: target.conversation.slice(-50),
      });
      target.saved = saved;
      target.savedSnapshot = snapshot();
      target.saved = await api<Task>("/tasks/" + idPath(saved.id));
      emit("saved");
    }
    if (review && target.saved) {
      target.saved = await api<Task>("/tasks/" + idPath(target.saved.id));
      emit("review", target.saved);
    } else success.value = copy.value.draftSavedToTheServerNotExecuted;
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
      let refresh = false;
      const applyWorkspace = (state: AgentWorkspace) => {
        if (state.draftId !== target.id || state.kind !== target.kind)
          throw Error(copy.value.invalidAiDraft);
        target.payload = { ...state.payload } as Payload;
        target.mapping = { ...state.mapping };
        target.recipientColumn = state.recipientColumn;
        target.templateId = state.templateId || "none";
        target.revision = state.revision;
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
            revision: target.revision,
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
              if (event.type === "workspace" && event.workspace) {
                applyWorkspace(event.workspace);
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
          ? {
              subject: proposal.payload.subject,
              html: proposal.payload.html,
            }
          : undefined;
        target.suggestionSnapshot = baseline;
        turn.status = "complete";
        turn.content = proposal.message;
        if (reviewTaskId) {
          const task = await api<Task>("/tasks/" + idPath(reviewTaskId));
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
  target.payload.subject = proposal.payload.subject;
  target.payload.html = proposal.payload.html;
  if (isDefaultDraftTitle(target.title))
    target.title = proposal.payload.subject || target.title;
  const recipientFields = fieldsIn({
    subject: "",
    html: "",
    ...Object.fromEntries(
      (target.kind === "email"
        ? ["to", "cc", "bcc"]
        : ["requiredAttendees", "optionalAttendees"]
      ).map((field) => [field, target.payload[field] || ""]),
    ),
  });
  for (const [field, column] of Object.entries(proposal.mapping || {}))
    if (target.columns.includes(column) && !recipientFields.includes(field))
      target.mapping[field] = column;
  target.templateId = "none";
  selectedTemplate.value = "none";
  target.proposal = undefined;
  agentOpen.value = false;
  success.value = copy.value.proposalApplied;
}
function quickAction(action: string) {
  if (action === "check") {
    draft.value.mergeOpen = true;
    if (issues.value.length)
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
            @click="activeId = item.id"
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
              >{{ item.saved ? copy.saved : copy.editing
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
        <p
          v-if="tasks.some((task) => task.status === 'draft')"
          class="section-label"
        >
          {{ copy.savedDrafts }}
        </p>
        <Button
          v-for="task in tasks
            .filter((task) => task.status === 'draft')
            .slice(0, 12)"
          :key="task.id"
          variant="ghost"
          class="task-entry"
          :disabled="busy"
          @click="reviewSaved(task)"
          ><strong>{{ task.summary }}</strong
          ><span class="muted text-xs"
            >{{ copy.savedClickToReview }} · {{ task.total }}</span
          ></Button
        >
      </div>
      <p class="task-space-note">
        <ShieldCheck :size="14" />{{
          copy.editsLastForThisSessionSaveToKeepAServerDraft
        }}
      </p>
    </aside>
    <div class="compose-region">
      <section class="compose-workspace">
        <div class="mobile-draft-switch">
          <AppSelect
            v-model="activeId"
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

        <Card class="merge-panel"
          ><div class="merge-summary">
            <Button
              variant="ghost"
              class="merge-expand"
              :aria-expanded="draft.mergeOpen"
              @click="draft.mergeOpen = !draft.mergeOpen"
              ><FileSpreadsheet :size="18" /><span>
                <ChevronDown v-if="draft.mergeOpen" :size="15" /><ChevronRight
                  v-else
                  :size="15"
                /><strong>{{
                  draft.kind === "email" ? copy.mailMerge : copy.batchEvents
                }}</strong></span
              ></Button
            ><span
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
            ><Button
              variant="outline"
              size="sm"
              :disabled="busy"
              @click="fileInput?.click()"
              ><Upload />{{
                draft.rows.length ? copy.replaceList : copy.importList
              }}</Button
            ><Button
              v-if="draft.rows.length"
              variant="ghost"
              size="icon-sm"
              :disabled="busy"
              :aria-label="copy.clearList"
              @click="clearOpen = true"
              ><X /></Button
            ><input
              ref="fileInput"
              type="file"
              accept=".csv,.xls,.xlsx"
              :aria-label="copy.importList"
              class="sr-only"
              tabindex="-1"
              @change="importFile"
            />
          </div>
          <div v-if="draft.mergeOpen" class="merge-body">
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
                  :options="sampleOptions" /></label
            ></template>
          </div>
        </Card>
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
            @agent="agentOpen = true"
          />
          <div class="editor-status">
            <span>{{ copy.savedDraftsAreAvailableInHistory }}</span
            ><span>{{ savedCurrent ? copy.saved : copy.unsavedEdits }}</span>
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
              {{ savedCurrent ? copy.serverDraft : copy.unsaved }}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
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
    <Dialog v-model:open="clearOpen"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{ copy.clearImportedData }}</DialogTitle
          ><DialogDescription>{{
            copy.clearListWarning
          }}</DialogDescription></DialogHeader
        >
        <div class="actions">
          <Button variant="outline" @click="clearOpen = false">{{
            copy.back
          }}</Button
          ><Button variant="destructive" @click="clearData">{{
            copy.clearList
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </div>
</template>
