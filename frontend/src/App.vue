<script setup lang="ts">
import { useMessages, taskError } from "@/lib/i18n";
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  Mail,
  LayoutDashboard,
  History,
  Files,
  Settings as SettingsIcon,
  Cable,
  ArrowUpRight,
  Moon,
  Sun,
  ShieldCheck,
  LogOut,
  RefreshCw,
  Plus,
  Copy,
  KeyRound,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import WorkspaceView from "@/components/WorkspaceView.vue";
import TaskContent from "@/components/TaskContent.vue";
import AppSelect from "@/components/ui/AppSelect.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import HtmlEditor from "@/components/HtmlEditor.vue";
import NotificationCenter from "@/components/NotificationCenter.vue";
import { useFeedback } from "@/lib/notifications";
import { fieldsIn } from "@/lib/mailMerge";
import SettingsPage from "@/components/SettingsPage.vue";
import {
  api,
  setCsrf,
  idPath,
  ApiError,
  type AuthStatus,
  type Template,
  type Task,
  type Kind,
  type Payload,
  type Key,
} from "@/lib/api";
import { setLocale, savedLocale } from "@/lib/i18n";

const copy = useMessages("app");
const language = ref<string>(savedLocale());
watch(
  language,
  (value) => {
    setLocale(value);
  },
  { immediate: true },
);
const page = ref("dashboard");
const workspaceBusy = ref(false);
const humanConfirmed = ref(false);
const dark = ref(false);
try {
  dark.value = localStorage.getItem("omnimail-theme") === "dark";
} catch {}
watch(
  dark,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
    try {
      localStorage.setItem("omnimail-theme", value ? "dark" : "light");
    } catch {}
  },
  { immediate: true },
);

const pages = computed(() => [
  { id: "dashboard", name: copy.value.workspace, icon: LayoutDashboard },
  { id: "history", name: copy.value.history, icon: History },
  { id: "templates", name: copy.value.templates, icon: Files },
  { id: "settings", name: copy.value.settings, icon: SettingsIcon },
  { id: "mcp", name: copy.value.mcp, icon: Cable },
]);
const auth = ref<AuthStatus>();
const busy = ref(false);
const loading = ref(true);
const error = ref("");
const success = ref("");
const name = ref("");
const setupToken = ref("");
useFeedback({
  error,
  success,
  pending: () =>
    loading.value ? copy.value.connectingAndLoadingWorkspace : "",
  errorAction: () => ({
    label: copy.value.retry,
    run: () => (auth.value?.authenticated ? run(loadPage) : status()),
    disabled: () => busy.value || loading.value,
  }),
  warning: () =>
    page.value === "mcp" ? copy.value.mcpAuthorizationWarning : "",
});
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (e instanceof ApiError && e.status === 401) {
      auth.value = undefined;
      await status();
    }
  } finally {
    busy.value = false;
  }
}
async function status() {
  loading.value = true;
  error.value = "";
  try {
    auth.value = await api<AuthStatus>("/auth/status");
    setCsrf(auth.value.csrfToken);
    if (auth.value.authenticated) await loadPage();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
async function login() {
  await run(async () => {
    const options = await api<
      Parameters<typeof startAuthentication>[0]["optionsJSON"]
    >("/auth/login/options", "POST", {});
    const response = await startAuthentication({ optionsJSON: options });
    await api("/auth/login/verify", "POST", { response });
    await status();
  });
}
async function register() {
  await run(async () => {
    const options = await api<
      Parameters<typeof startRegistration>[0]["optionsJSON"]
    >("/auth/register/options", "POST", {
      name: name.value,
      setupToken: setupToken.value || undefined,
    });
    const response = await startRegistration({ optionsJSON: options });
    await api("/auth/register/verify", "POST", { response, name: name.value });
    setupToken.value = "";
    await status();
  });
}
const templates = ref<Template[]>([]);
const tasks = ref<Task[]>([]);
const keys = ref<Key[]>([]);
async function loadPage() {
  loading.value = true;
  try {
    if (["dashboard", "history", "templates"].includes(page.value)) {
      const [loadedTemplates, loadedTasks] = await Promise.all([
        api<Template[]>("/templates"),
        api<Task[]>("/tasks"),
      ]);
      templates.value = loadedTemplates;
      tasks.value = loadedTasks;
    } else if (page.value === "mcp") keys.value = await api<Key[]>("/mcp/keys");
  } finally {
    loading.value = false;
  }
}
watch(page, () => {
  detail.value = undefined;
  detailOpen.value = false;
  oneTimeKey.value = "";
  error.value = "";
  success.value = "";
  if (auth.value?.authenticated && !busy.value) void run(loadPage);
});
const kind = ref<Kind>("email");
const payload = ref<Payload>({
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  html: "",
});
const review = ref<Task>();
const reviewOpen = ref(false);
watch(reviewOpen, () => {
  humanConfirmed.value = false;
});
const detail = ref<Task>();
const detailOpen = ref(false);
const filter = ref("all");
const templateFilter = ref("all");
const sourceFilter = ref("all");
const fromDate = ref("");
const toDate = ref("");
function recipientCount(task: Task) {
  return (task.items ?? []).reduce(
    (count, item) =>
      count +
      (task.kind === "email"
        ? ["to", "cc", "bcc"]
        : ["requiredAttendees", "optionalAttendees"]
      ).reduce(
        (n, key) =>
          n +
          (item.payload[key] || "").split(";").filter((x) => x.trim()).length,
        0,
      ),
    0,
  );
}
const statuses = [
  "draft",
  "queued",
  "running",
  "accepted",
  "failed",
  "uncertain",
  "cancelled",
] as const;
const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(language.value === "en" ? "en-GB" : "zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(date)
    : value;
};
const kindLabel = (value: Kind) =>
  value === "email" ? copy.value.email : copy.value.event;
const stateLabel = (state: string) =>
  copy.value.statuses[state as keyof typeof copy.value.statuses] || state;
const filtered = computed(() =>
  tasks.value.filter(
    (x) =>
      (filter.value === "all" || x.status === filter.value) &&
      (templateFilter.value === "all" ||
        x.templateId === templateFilter.value) &&
      (sourceFilter.value === "all" ||
        (sourceFilter.value === "web"
          ? x.source.startsWith("web")
          : sourceFilter.value === "test"
            ? x.source === "web:test-email"
            : x.source.startsWith("mcp:"))) &&
      (!fromDate.value || x.createdAt.slice(0, 10) >= fromDate.value) &&
      (!toDate.value || x.createdAt.slice(0, 10) <= toDate.value),
  ),
);
async function confirm() {
  await run(async () => {
    if (
      !review.value ||
      !humanConfirmed.value ||
      review.value.status !== "draft"
    )
      return;
    await api("/tasks/" + idPath(review.value.id) + "/confirm", "POST", {});
    detail.value = await api<Task>("/tasks/" + idPath(review.value.id));
    reviewOpen.value = false;
    page.value = "history";
    detailOpen.value = true;
    success.value = copy.value.queueRequestedAcceptanceDoesNotMeanDelivery;
    await loadPage();
    detail.value = await api<Task>("/tasks/" + idPath(review.value.id));
  });
}
async function openTask(x: Task) {
  await run(async () => {
    detail.value = await api<Task>("/tasks/" + idPath(x.id));
    detailOpen.value = true;
  });
}
async function cancelTask(x: Task) {
  await run(async () => {
    await api("/tasks/" + idPath(x.id) + "/cancel", "POST", {});
    detail.value = await api<Task>("/tasks/" + idPath(x.id));
    await loadPage();
  });
}
const templateEdit = ref<Partial<Template>>();
const versions = ref<Template[]>([]);
function editTemplate(x?: Template) {
  templateEdit.value = x
    ? { ...x }
    : {
        name: "",
        description: "",
        kind: kind.value,
        subject: payload.value.subject,
        html: payload.value.html,
      };
  versions.value = [];
}
async function saveTemplate() {
  await run(async () => {
    const x = templateEdit.value;
    if (!x?.name?.trim() || !x.subject?.trim())
      throw Error(copy.value.nameAndSubjectRequired);
    const fields = [
      ...new Set(
        Array.from(
          ((x.subject || "") + " " + (x.html || "")).matchAll(
            /{{\s*([^{}]+?)\s*}}/g,
          ),
        ).map((m) => m[1]!.trim()),
      ),
    ];
    await api(
      x.id ? "/templates/" + idPath(x.id) : "/templates",
      x.id ? "PUT" : "POST",
      {
        name: x.name,
        expectedVersion: x.id ? x.version : undefined,
        description: x.description,
        kind: x.kind,
        subject: x.subject,
        html: x.html,
        fields,
      },
    );
    templateEdit.value = undefined;
    await loadPage();
    success.value = copy.value.templateSaved;
  });
}
const deleteRequest = ref<{ path: string; name: string }>();
async function remove() {
  await run(async () => {
    if (!deleteRequest.value) return;
    await api(deleteRequest.value.path, "DELETE");
    deleteRequest.value = undefined;
    await loadPage();
    success.value = copy.value.deleted;
  });
}
const keyName = ref("");
const oneTimeKey = ref("");
useFeedback({
  warning: () => (oneTimeKey.value ? copy.value.apiKeySecurityWarning : ""),
});
const endpoint = location.origin + "/mcp";
const mcpConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        omnimail: {
          url: endpoint,
          headers: { Authorization: "Bearer <YOUR_API_KEY>" },
        },
      },
    },
    null,
    2,
  ),
);
async function createKey() {
  await run(async () => {
    const x = await api<{ id: string; key: string }>("/mcp/keys", "POST", {
      name: keyName.value,
    });
    oneTimeKey.value = x.key;
    keyName.value = "";
    await loadPage();
  });
}
const poll = setInterval(() => {
  if (
    detail.value &&
    ["queued", "running"].includes(detail.value.status) &&
    !busy.value
  )
    void run(async () => {
      detail.value = await api<Task>("/tasks/" + idPath(detail.value!.id));
    });
}, 3000);
onUnmounted(() => clearInterval(poll));
onMounted(status);
const navigator = window.navigator;
const placeholderHint = computed(
  () => copy.value.supportsDoubleBracePlaceholders,
);
</script>
<template>
  <NotificationCenter />
  <div v-if="!auth?.authenticated" class="auth page-enter">
    <div class="brand mb-8"><ArrowUpRight />{{ copy.omniMail }}</div>
    <Card class="panel"
      ><div class="eyebrow">{{ copy.secureWorkspace }}</div>
      <h1>
        {{ auth?.needsSetup ? copy.initializeWorkspace : copy.welcomeBack }}
      </h1>
      <p class="muted">
        {{ copy.signInSecurelyWithAPasskeyNoPasswordRequired }}
      </p>
      <Button
        variant="ghost"
        @click="language = language === 'en' ? 'zh' : 'en'"
        >{{ copy.english }}</Button
      >

      <Button
        v-if="!auth"
        class="mt-4"
        :disabled="loading || busy"
        @click="status"
        >{{ copy.reconnect }}</Button
      ><template v-if="auth"
        ><Button
          v-if="!auth.needsSetup"
          class="w-full mt-4"
          :disabled="busy"
          @click="login"
          >{{ copy.signInWithPasskey }}</Button
        >
        <form v-if="auth.needsSetup" @submit.prevent="register">
          <label class="field"
            ><span>{{ copy.passkeyName }}</span
            ><Input v-model="name" required autocomplete="username" /></label
          ><label v-if="auth.needsSetup" class="field"
            ><span>{{ copy.setupTokenProvidedByServer }}</span
            ><Input
              v-model="setupToken"
              type="password"
              autocomplete="off" /></label
          ><Button
            class="w-full mt-4"
            variant="outline"
            :disabled="busy || !name.trim()"
            >{{ busy ? copy.working : copy.registerPasskey }}</Button
          >
        </form></template
      >
      <p class="muted text-xs">
        {{ copy.passkeyRequirements }}
      </p></Card
    >
  </div>
  <div v-else class="shell">
    <aside class="sidebar rail">
      <div class="brand rail-brand" :aria-label="copy.omniMail"><Mail /></div>
      <nav :aria-label="copy.mainNavigation">
        <Button
          variant="ghost"
          v-for="item in pages"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :disabled="busy || workspaceBusy"
          :title="item.name"
          @click="page = item.id"
        >
          <component :is="item.icon" :size="20" /><span>{{ item.name }}</span>
        </Button>
      </nav>
      <div class="rail-footer">
        <Button
          variant="ghost"
          size="icon"
          :aria-label="copy.toggleTheme"
          :title="copy.toggleTheme"
          @click="dark = !dark"
          ><Sun v-if="dark" /><Moon v-else
        /></Button>
        <div class="session-avatar" :title="copy.passkeySecuredSession">
          <ShieldCheck :size="18" />
        </div>
      </div>
    </aside>
    <main class="min-w-0">
      <header class="topbar">
        <div>
          <span class="mobile-brand">{{ copy.omniMail2 }} </span
          ><span class="muted">{{ copy.workspace2 }} / </span
          >{{ pages.find((x) => x.id === page)?.name }}
        </div>
        <div class="row">
          <Button
            variant="ghost"
            @click="language = language === 'en' ? 'zh' : 'en'"
            >{{
              language === "en" ? copy.chineseLanguage : copy.englishLanguage
            }}</Button
          ><Button
            variant="ghost"
            :aria-label="copy.signOut"
            :disabled="busy || workspaceBusy"
            @click="
              run(async () => {
                await api('/auth/logout', 'POST', {});
                auth = undefined;
                await status();
              })
            "
            ><LogOut :size="15" /><span class="signout-label">{{
              copy.signOut
            }}</span></Button
          >
        </div>
      </header>
      <div class="content" :class="{ 'desk-content': page === 'dashboard' }">
        <WorkspaceView
          v-show="page === 'dashboard'"
          :templates="templates"
          :tasks="tasks"
          :dark="dark"
          :visible="page === 'dashboard'"
          :locked="busy"
          @expired="status"
          @busy="workspaceBusy = $event"
          @review="
            review = $event;
            reviewOpen = true;
          "
          @saved="run(loadPage)"
          @settings="page = 'settings'"
          @template="
            (draftKind, draftPayload) => {
              kind = draftKind;
              payload = draftPayload;
              editTemplate();
            }
          "
        />
        <section v-if="page === 'history'" class="page-enter">
          <div class="heading row between">
            <div>
              <h1>{{ copy.executionHistory }}</h1>
              <p class="muted">
                {{ copy.historyDeliveryHint }}
              </p>
            </div>
            <Button variant="outline" :disabled="busy" @click="run(loadPage)"
              ><RefreshCw />{{ copy.refresh }}</Button
            >
          </div>
          <Card class="panel"
            ><label class="field"
              ><span>{{ copy.filterStatus }}</span
              ><AppSelect
                v-model="filter"
                :options="[
                  { value: 'all', label: copy.allStatuses },
                  ...statuses.map((status) => ({
                    value: status,
                    label: stateLabel(status),
                  })),
                ]"
            /></label>
            <div class="form-grid">
              <label class="field"
                ><span>{{ copy.template }}</span
                ><AppSelect
                  v-model="templateFilter"
                  :options="[
                    { value: 'all', label: copy.allTemplates },
                    ...templates.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]"
              /></label>
              <label class="field"
                ><span>{{ copy.source }}</span
                ><AppSelect
                  v-model="sourceFilter"
                  :options="[
                    { value: 'all', label: copy.allSources },
                    { value: 'web', label: copy.web },
                    { value: 'test', label: copy.testEmail },
                    { value: 'mcp', label: copy.mcp },
                  ]"
              /></label>
              <label class="field"
                ><span>{{ copy.fromDate }}</span
                ><Input v-model="fromDate" type="date"
              /></label>
              <label class="field"
                ><span>{{ copy.toDate }}</span
                ><Input v-model="toDate" type="date"
              /></label>
            </div>
            <div v-if="!filtered.length && !loading" class="empty">
              {{ copy.noTasksYet }}
            </div>
            <div v-for="x in filtered" :key="x.id" class="record row between">
              <div>
                <strong>{{ x.summary || x.id }}</strong>
                <p class="muted text-xs">
                  {{ kindLabel(x.kind) }} ·
                  {{
                    x.source === "web:test-email"
                      ? copy.testEmail
                      : x.source.startsWith("mcp:")
                        ? copy.mcp
                        : copy.web
                  }}
                  ·
                  {{ formatDate(x.createdAt) }}
                </p>
                <span class="badge">{{ stateLabel(x.status) }}</span> ·
                {{ copy.total }} {{ x.total }} / {{ copy.accepted }}
                {{ x.accepted }} / {{ copy.failed }} {{ x.failed }}
              </div>
              <Button variant="outline" :disabled="busy" @click="openTask(x)">{{
                copy.details
              }}</Button>
            </div></Card
          >
        </section>
        <section v-if="page === 'templates'" class="page-enter">
          <div class="heading row between">
            <div>
              <h1>{{ copy.templates2 }}</h1>
              <p class="muted">{{ placeholderHint }}</p>
            </div>
            <Button @click="editTemplate()"
              ><Plus />{{ copy.newTemplate }}</Button
            >
          </div>
          <Card class="panel"
            ><div v-if="!templates.length && !loading" class="empty">
              {{ copy.noTemplatesCreateYourFirstOne }}
            </div>
            <div v-for="x in templates" :key="x.id" class="record">
              <div class="row between">
                <div>
                  <strong>{{ x.name }}</strong>
                  <span class="badge"
                    >{{ kindLabel(x.kind) }} {{ copy.v }}{{ x.version }}</span
                  >
                  <p class="muted">{{ x.description }}</p>
                  <p>{{ x.subject }}</p>
                </div>
                <div class="row">
                  <Button variant="outline" @click="editTemplate(x)">{{
                    copy.edit
                  }}</Button
                  ><Button
                    variant="ghost"
                    @click="
                      deleteRequest = {
                        path: '/templates/' + idPath(x.id),
                        name: x.name,
                      }
                    "
                    >{{ copy.delete }}</Button
                  >
                </div>
              </div>
            </div></Card
          >
        </section>
        <SettingsPage
          v-if="page === 'settings'"
          :language="language"
          @language="language = $event"
        />
        <section v-if="page === 'mcp'" class="page-enter">
          <div class="heading">
            <h1>{{ copy.mcpService }}</h1>
            <p class="muted">
              {{ copy.connectMCPCompatibleClientsToOmniMail }}
            </p>
          </div>

          <div class="workspace">
            <Card class="panel"
              ><h2 class="icon-label">
                <KeyRound :size="18" />{{ copy.apiKeys }}
              </h2>
              <form @submit.prevent="createKey">
                <label class="field"
                  ><span>{{ copy.keyName }}</span
                  ><Input v-model="keyName" required /></label
                ><Button class="mt-4" :disabled="busy || !keyName.trim()">{{
                  copy.createKey
                }}</Button>
              </form>
              <div v-if="oneTimeKey" class="secret-key-panel mt-4">
                <strong>{{ copy.newApiKey }}</strong>
                <pre>{{ oneTimeKey }}</pre>
                <Button
                  variant="outline"
                  @click="
                    run(async () => {
                      await navigator.clipboard.writeText(oneTimeKey);
                      success = copy.copied;
                    })
                  "
                  >{{ copy.copy }}</Button
                >
                <Button variant="ghost" @click="oneTimeKey = ''">{{
                  copy.savedHide
                }}</Button>
              </div>
              <div v-if="!keys.length && !loading" class="empty">
                {{ copy.noKeys }}
              </div>
              <div v-for="x in keys" :key="x.id" class="record row between">
                <div>
                  {{ x.name }}
                  <p class="muted text-xs">
                    {{ x.prefix }}… · {{ formatDate(x.createdAt) }}
                  </p>
                </div>
                <Button
                  variant="outline"
                  @click="
                    deleteRequest = {
                      path: '/mcp/keys/' + idPath(x.id),
                      name: x.name,
                    }
                  "
                  >{{ copy.revoke }}</Button
                >
              </div></Card
            ><Card class="panel"
              ><h2>{{ copy.clientConfiguration }}</h2>
              <pre>{{ mcpConfig }}</pre>
              <p class="muted">
                {{ copy.replaceThePlaceholderWithYourNewlyCreatedKey }}
              </p>
              <p>{{ copy.sendEmailCreateEventGetTaskListTemplates }}</p>
              <p class="muted">
                {{ copy.noEmailOrCalendarCallsExecuteOnThisPage }}
              </p></Card
            >
          </div>
        </section>
      </div>
    </main>
  </div>
  <Dialog v-model:open="detailOpen"
    ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
      ><DialogHeader
        ><DialogTitle>{{
          detail?.summary || detail?.id || copy.taskDetails
        }}</DialogTitle
        ><DialogDescription>{{
          copy.taskDeliveryHint
        }}</DialogDescription></DialogHeader
      ><template v-if="detail"
        ><div class="row between">
          <span class="badge">{{ stateLabel(detail.status) }}</span>
          <span class="muted text-xs">{{ formatDate(detail.createdAt) }}</span>
        </div>
        <p v-if="detail.template" class="muted">
          {{ copy.template2 }}: {{ detail.template.name }} {{ copy.v
          }}{{ detail.template.version }}
        </p>
        <TaskContent :key="detail.id" :task="detail" />
        <p>
          {{ copy.interfaceCalls }}: {{ detail.total }} · {{ copy.accepted2 }}
          {{ detail.accepted }} ·
          {{ copy.failed }}
          {{ detail.failed }}
        </p>
        <div class="merge-table-scroll">
          <table class="data-table task-results">
            <caption class="sr-only">
              {{
                copy.perItemResults
              }}
            </caption>
            <thead>
              <tr>
                <th>
                  {{ copy.recipientsAttendees }}
                </th>
                <th>{{ copy.status }}</th>
                <th>{{ copy.resultDetails }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in detail.items" :key="item.id">
                <td>
                  {{
                    item.payload.to ||
                    item.payload.requiredAttendees ||
                    copy.none
                  }}
                </td>
                <td>
                  <span class="badge">{{ stateLabel(item.status) }}</span>
                </td>
                <td>
                  {{ taskError(item) || copy.noAdditionalError }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-for="(x, i) in detail.conversation" :key="i" class="bubble">
          {{ x.role }}: {{ x.content }}
        </div>
        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="openTask(detail)"
            >{{ copy.refresh }}</Button
          ><Button
            v-if="detail.status === 'draft'"
            :disabled="busy"
            @click="
              review = detail;
              reviewOpen = true;
            "
            >{{ copy.reviewConfirm }}</Button
          ><Button
            v-if="['draft', 'queued', 'running'].includes(detail.status)"
            variant="outline"
            :disabled="busy"
            @click="cancelTask(detail)"
            >{{ copy.cancelTask }}</Button
          >
        </div></template
      ></DialogContent
    ></Dialog
  >
  <Dialog v-model:open="reviewOpen"
    ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
      ><DialogHeader
        ><DialogTitle>{{ copy.confirmBeforeExecution }}</DialogTitle
        ><DialogDescription>{{
          copy.executionReviewHint
        }}</DialogDescription></DialogHeader
      ><template v-if="review"
        ><p>
          {{ review.kind === "email" ? copy.email : copy.event }}
          · {{ copy.interfaceCalls }}: {{ review.total }} ·
          {{ copy.recipientAddressesIncludingCCBCC }}:
          {{ recipientCount(review) }}
        </p>
        <TaskContent :key="review.id" :task="review" /><label
          class="confirm-check"
          ><AppCheckbox
            v-model="humanConfirmed"
            :disabled="busy || review.status !== 'draft'"
          /><span>{{ copy.executionConsent }}</span></label
        >

        <div class="actions">
          <Button
            variant="outline"
            :disabled="busy"
            @click="reviewOpen = false"
            >{{ copy.keepDraft }}</Button
          ><Button
            :disabled="busy || !humanConfirmed || review.status !== 'draft'"
            @click="confirm"
            >{{ copy.confirmExecution }}</Button
          >
        </div></template
      ></DialogContent
    ></Dialog
  >
  <Dialog
    :open="!!templateEdit"
    @update:open="!$event && (templateEdit = undefined)"
    ><DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
      ><DialogHeader
        ><DialogTitle>{{ copy.editTemplate }}</DialogTitle
        ><DialogDescription>{{
          copy.templateEditorHint
        }}</DialogDescription></DialogHeader
      >
      <form v-if="templateEdit" @submit.prevent="saveTemplate">
        <label class="field"
          ><span>{{ copy.name }}</span
          ><Input v-model="templateEdit.name" required /></label
        ><label class="field"
          ><span>{{ copy.description }}</span
          ><Input v-model="templateEdit.description" /></label
        ><label class="field"
          ><span>{{ copy.kind }}</span
          ><AppSelect
            v-model="templateEdit.kind"
            :options="[
              { value: 'email', label: copy.email },
              { value: 'event', label: copy.event },
            ]" /></label
        ><label class="field"
          ><span>{{ copy.subject }}</span
          ><Input v-model="templateEdit.subject" required /></label
        ><HtmlEditor
          v-model="templateEdit.html!"
          :preview-subject="templateEdit.subject"
          :dark="dark"
          :disabled="busy"
          :fields="
            fieldsIn({
              subject: templateEdit.subject || '',
              html: templateEdit.html || '',
            })
          "
        />

        <div class="actions">
          <Button
            v-if="templateEdit.id"
            type="button"
            variant="outline"
            :disabled="busy"
            @click="
              run(async () => {
                versions = await api<Template[]>(
                  '/templates/' + idPath(templateEdit!.id!) + '/versions',
                );
              })
            "
            >{{ copy.versions }}</Button
          ><Button :disabled="busy">{{ copy.save }}</Button>
        </div>
        <div v-for="v in versions" :key="v.version" class="record row between">
          <span>{{ copy.v2 }}{{ v.version }} · {{ v.subject }}</span
          ><Button
            type="button"
            variant="outline"
            :disabled="busy"
            @click="
              run(async () => {
                await api(
                  '/templates/' + idPath(templateEdit!.id!) + '/rollback',
                  'POST',
                  {
                    version: v.version,
                    expectedVersion: templateEdit!.version,
                  },
                );
                templateEdit = undefined;
                await loadPage();
                success = copy.rolledBack;
              })
            "
            >{{ copy.rollBack }}</Button
          >
        </div>
      </form></DialogContent
    ></Dialog
  >
  <Dialog
    :open="!!deleteRequest"
    @update:open="!$event && (deleteRequest = undefined)"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>{{ copy.confirmDeletionRevocation }}</DialogTitle
        ><DialogDescription
          >{{ deleteRequest?.name }} ·
          {{ copy.thisCannotBeUndone }}</DialogDescription
        ></DialogHeader
      >

      <div class="actions">
        <Button variant="outline" @click="deleteRequest = undefined">{{
          copy.back
        }}</Button
        ><Button variant="destructive" :disabled="busy" @click="remove">{{
          copy.confirmDelete
        }}</Button>
      </div></DialogContent
    ></Dialog
  >
</template>
