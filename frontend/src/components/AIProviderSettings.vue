<script setup lang="ts">
import { useMessages, message } from "@/lib/i18n";
import AppSelect from "@/components/ui/AppSelect.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import { computed, onUnmounted, ref, watch } from "vue";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "reka-ui";
import {
  Check,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError, idPath, type Provider } from "@/lib/api";
import { useFeedback, notify } from "@/lib/notifications";

const copy = useMessages("aiProviderSettings");
const editing = ref<DraftConfig>();

const deleteServiceLabel = (name: string) =>
  message("aiProviderSettings.deleteService", { name });

const props = defineProps<{
  providers: Provider[];
  defaultProviderId: string;
}>();
const emit = defineEmits<{ updated: [] }>();
type DraftConfig = Partial<Provider> & { apiKey?: string };
type Verification = {
  ok: boolean;
  capability: string;
  latencyMs: number;
  model: string;
  preview: { subject: string; html: string };
};

const activity = ref<
  "discover" | "verify" | "save" | "default" | "delete" | ""
>("");
const models = ref<{ id: string; name: string }[]>([]);
const discovery = ref<"idle" | "loading" | "ready" | "unsupported" | "error">(
  "idle",
);
const modelError = ref("");
const error = ref("");
const success = ref("");
const verification = ref<Verification>();
const advanced = ref(false);
const replaceHeaders = ref(false);
const customHeaders = ref("{}");
const makeDefault = ref(true);
const modelSearch = ref("");
const hasMore = ref(false);
const deleting = ref<Provider>();
let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
const busy = computed(() => !!activity.value);
useFeedback({
  error,
  success,
  pending: () =>
    activity.value
      ? activity.value === "discover"
        ? copy.value.discoveringModels
        : activity.value === "verify"
          ? copy.value.verifyingDrafting
          : copy.value.updatingAiConfiguration
      : "",
});
useFeedback({
  error: modelError,
  errorAction: () => ({
    label: copy.value.retryModelDiscovery,
    run: discover,
    disabled: () => busy.value || !canDiscover(),
  }),
});
watch(verification, (value) => {
  if (value) notify.success(copy.value.draftingVerifiedNoEmailSent);
});
const filteredModels = computed(() =>
  models.value.filter((model) =>
    `${model.id} ${model.name}`
      .toLowerCase()
      .includes(modelSearch.value.toLowerCase()),
  ),
);
const selectedOutsideList = computed(
  () =>
    editing.value?.model &&
    !models.value.some((model) => model.id === editing.value?.model),
);
const presets = computed(() => [
  {
    id: "openai",
    label: copy.value.openai,
    protocol: "openai-responses" as const,
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: copy.value.anthropic,
    protocol: "anthropic" as const,
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "glm",
    label: copy.value.glm,
    protocol: "openai-chat" as const,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "custom",
    label: copy.value.custom,
    protocol: "openai-chat" as const,
    baseUrl: "",
  },
]);
const preset = ref("custom");
const protocolName = (protocol: Provider["protocol"]) =>
  protocol === "anthropic"
    ? copy.value.anthropicMessages
    : protocol === "openai-chat"
      ? copy.value.openaiChatCompletions
      : copy.value.openaiResponses;
function friendlyError(cause: unknown) {
  if (!(cause instanceof ApiError))
    return cause instanceof Error ? cause.message : String(cause);
  return cause.code
    ? copy.value.errors[cause.code as keyof typeof copy.value.errors] ||
        cause.message
    : cause.message;
}
function open(provider?: Provider) {
  clearTimeout(discoveryTimer);
  revision++;
  editing.value = provider
    ? { ...provider, apiKey: "" }
    : {
        name: "",
        protocol: "openai-chat",
        baseUrl: "",
        model: "",
        apiKey: "",
        outputMode: "auto",
      };
  preset.value = provider?.baseUrl.includes("open.bigmodel.cn")
    ? "glm"
    : provider?.baseUrl.includes("api.openai.com")
      ? "openai"
      : provider?.baseUrl.includes("api.anthropic.com")
        ? "anthropic"
        : "custom";
  replaceHeaders.value = false;
  customHeaders.value = "{}";
  models.value = [];
  modelSearch.value = "";
  discovery.value = "idle";
  modelError.value = "";
  error.value = "";
  verification.value = undefined;
  advanced.value = false;
  makeDefault.value =
    !props.defaultProviderId || provider?.id === props.defaultProviderId;
  if (provider) scheduleDiscovery();
}
function choosePreset(value: string) {
  if (!editing.value) return;
  preset.value = value;
  const choice = presets.value.find((item) => item.id === value)!;
  editing.value.protocol = choice.protocol;
  editing.value.baseUrl = choice.baseUrl;
  editing.value.model = "";
  if (!editing.value.id)
    editing.value.name = value === "custom" ? "" : choice.label;
}
function config() {
  if (!editing.value) throw Error(copy.value.noProviderSelected);
  let headers: Record<string, string> | undefined;
  if (replaceHeaders.value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(customHeaders.value || "{}");
    } catch {
      throw Error(copy.value.customHeadersMustBeAJSONObject);
    }
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      Object.values(parsed).some((value) => typeof value !== "string")
    )
      throw Error(copy.value.headerNamesAndValuesMustBeStrings);
    headers = parsed as Record<string, string>;
  }
  const provider = editing.value;
  let name = provider.name?.trim();
  if (!name) {
    try {
      name = new URL(provider.baseUrl || "").hostname;
    } catch {
      name = copy.value.customAi;
    }
  }
  return {
    id: provider.id,
    name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl?.trim(),
    model: provider.model || "",
    apiKey: provider.apiKey?.trim() || undefined,
    outputMode: provider.outputMode || "auto",
    ...(headers === undefined ? {} : { headers }),
  };
}
function canDiscover() {
  const provider = editing.value;
  if (!provider?.baseUrl || (!provider.apiKey?.trim() && !provider.hasApiKey))
    return false;
  try {
    return ["http:", "https:"].includes(new URL(provider.baseUrl).protocol);
  } catch {
    return false;
  }
}
function scheduleDiscovery() {
  clearTimeout(discoveryTimer);
  if (!canDiscover() || busy.value) return;
  discoveryTimer = setTimeout(() => void discover(), 700);
}
watch(
  () => [
    editing.value?.baseUrl,
    editing.value?.protocol,
    editing.value?.apiKey,
    replaceHeaders.value,
    customHeaders.value,
  ],
  () => {
    revision++;
    models.value = [];
    discovery.value = "idle";
    modelError.value = "";
    verification.value = undefined;
    scheduleDiscovery();
  },
);
watch(
  () => [editing.value?.model, editing.value?.outputMode],
  () => {
    verification.value = undefined;
    error.value = "";
  },
);
async function discover() {
  clearTimeout(discoveryTimer);
  if (!editing.value || busy.value || !canDiscover()) return;
  const requestRevision = revision;
  activity.value = "discover";
  discovery.value = "loading";
  modelError.value = "";
  try {
    const response = await api<{
      models: { id: string; name: string }[];
      hasMore: boolean;
    }>("/providers/discover", "POST", config());
    if (requestRevision !== revision || !editing.value) return;
    models.value = response.models;
    hasMore.value = response.hasMore;
    discovery.value = "ready";
    if (!editing.value.model && response.models.length === 1)
      editing.value.model = response.models[0]!.id;
  } catch (cause) {
    if (requestRevision !== revision) return;
    modelError.value = friendlyError(cause);
    discovery.value =
      cause instanceof ApiError &&
      ["endpoint_unsupported", "models_unsupported"].includes(cause.code || "")
        ? "unsupported"
        : "error";
  } finally {
    activity.value = "";
    if (requestRevision !== revision && editing.value) scheduleDiscovery();
  }
}
async function verify() {
  if (busy.value || !editing.value) return;
  clearTimeout(discoveryTimer);
  activity.value = "verify";
  error.value = "";
  verification.value = undefined;
  try {
    verification.value = await api<Verification>(
      "/providers/verify",
      "POST",
      config(),
    );
  } catch (cause) {
    error.value = friendlyError(cause);
  } finally {
    activity.value = "";
  }
}
async function saveProvider() {
  if (busy.value || !editing.value) return;
  if (!editing.value.model?.trim()) {
    error.value = copy.value.chooseAModelBeforeSaving;
    return;
  }
  clearTimeout(discoveryTimer);
  activity.value = "save";
  error.value = "";
  try {
    const provider = config();
    await api(
      provider.id ? `/providers/${idPath(provider.id)}` : "/providers",
      provider.id ? "PUT" : "POST",
      { ...provider, makeDefault: makeDefault.value },
    );
    editing.value = undefined;
    revision++;
    success.value = makeDefault.value
      ? copy.value.savedAndSelectedAsTheDefaultDraftingService
      : copy.value.aIConfigurationSaved;
    emit("updated");
  } catch (cause) {
    error.value = friendlyError(cause);
  } finally {
    activity.value = "";
  }
}
async function selectDefault(provider: Provider) {
  if (busy.value) return;
  activity.value = "default";
  error.value = "";
  try {
    await api("/settings", "PUT", { defaultProviderId: provider.id });
    emit("updated");
    success.value = copy.value.defaultDraftingServiceUpdated;
  } catch (cause) {
    error.value = friendlyError(cause);
  } finally {
    activity.value = "";
  }
}
async function remove() {
  if (!deleting.value || busy.value) return;
  activity.value = "delete";
  error.value = "";
  try {
    await api(`/providers/${idPath(deleting.value.id)}`, "DELETE");
    deleting.value = undefined;
    emit("updated");
  } catch (cause) {
    error.value = friendlyError(cause);
  } finally {
    activity.value = "";
  }
}
function close(open: boolean) {
  if (open || (busy.value && activity.value !== "discover")) return;
  clearTimeout(discoveryTimer);
  revision++;
  editing.value = undefined;
}
onUnmounted(() => {
  clearTimeout(discoveryTimer);
  revision++;
});
</script>

<template>
  <section class="ai-module" aria-labelledby="ai-module-title">
    <header class="ai-module-heading">
      <div>
        <span class="ai-overline">{{ copy.aiConnections }}</span>
        <h2 id="ai-module-title">
          {{ copy.aiDraftingServices }}
        </h2>
        <p>
          {{ copy.description }}
        </p>
      </div>
      <Button variant="outline" :disabled="busy" @click="open()"
        ><Plus :size="16" />{{ copy.addService }}</Button
      >
    </header>

    <div v-if="!providers.length" class="ai-empty">
      <Server :size="28" />
      <h3>{{ copy.connectYourOwnAI }}</h3>
      <p>
        {{ copy.setupHint }}
      </p>
      <Button @click="open()"
        >{{ copy.setUpTheFirstService }}<ChevronRight :size="16"
      /></Button>
    </div>
    <div v-for="provider in providers" :key="provider.id" class="ai-provider">
      <div class="ai-provider-icon"><Server :size="19" /></div>
      <div class="ai-provider-info">
        <div class="ai-provider-title">
          <strong>{{ provider.name }}</strong
          ><span v-if="provider.id === defaultProviderId" class="ai-tag">{{
            copy.default
          }}</span>
        </div>
        <p>
          {{ provider.model || copy.noModelSelected }}<span> · </span
          >{{ protocolName(provider.protocol) }}
        </p>
        <small>{{ provider.baseUrl }}</small>
      </div>
      <div class="ai-provider-actions">
        <Button
          v-if="provider.id !== defaultProviderId"
          variant="ghost"
          :disabled="busy || !provider.model"
          @click="selectDefault(provider)"
          >{{ copy.useAsDefault }}</Button
        ><Button variant="outline" :disabled="busy" @click="open(provider)">{{
          copy.manage
        }}</Button
        ><Button
          variant="ghost"
          :aria-label="deleteServiceLabel(provider.name)"
          :disabled="busy"
          @click="deleting = provider"
          ><Trash2 :size="15"
        /></Button>
      </div>
    </div>
    <div v-if="providers.length && !defaultProviderId" class="ai-callout">
      <CircleHelp :size="16" />{{ copy.chooseADefaultServiceForTheWorkspace }}
    </div>
  </section>
  <Dialog :open="!!editing" @update:open="close">
    <DialogContent
      class="ai-config-dialog max-h-[92dvh] overflow-y-auto sm:max-w-[720px]"
    >
      <DialogHeader
        ><DialogTitle>{{
          editing?.id ? copy.manageAIService : copy.connectAnAIService
        }}</DialogTitle
        ><DialogDescription>{{
          copy.configurationPrivacyHint
        }}</DialogDescription></DialogHeader
      >
      <form v-if="editing" @submit.prevent="verify">
        <fieldset
          :disabled="busy && activity !== 'discover'"
          class="ai-fieldset"
        >
          <div class="ai-presets">
            <Button
              variant="ghost"
              v-for="choice in presets"
              :key="choice.id"
              type="button"
              :class="{ selected: preset === choice.id }"
              @click="choosePreset(choice.id)"
              >{{ choice.id === "custom" ? copy.custom : choice.label }}</Button
            >
          </div>
          <section class="ai-step">
            <div class="ai-step-title">
              <span>1</span>
              <h3>{{ copy.connect }}</h3>
              <small>{{ copy.modelsLoadAutomatically }}</small>
            </div>
            <div class="ai-grid">
              <label class="field"
                ><span>{{ copy.displayName }}</span
                ><Input
                  v-model="editing.name"
                  :placeholder="copy.eGTeamGLM"
                  autocomplete="off" /></label
              ><label class="field"
                ><span>{{ copy.aPIType }}</span
                ><AppSelect
                  v-model="editing.protocol"
                  :options="[
                    { value: 'openai-chat', label: copy.openaiChatCompletions },
                    { value: 'openai-responses', label: copy.openaiResponses },
                    { value: 'anthropic', label: copy.anthropicMessages },
                  ]"
              /></label>
            </div>
            <label class="field"
              ><span>{{ copy.aPIBaseURL }}</span
              ><Input
                v-model="editing.baseUrl"
                type="url"
                :placeholder="copy.httpsYourProviderExampleV1"
                autocomplete="off"
              /><small>{{ copy.baseUrlHint }}</small></label
            >
            <label class="field"
              ><span
                >{{ copy.apiKey }}
                <small v-if="editing.hasApiKey">{{
                  copy.savedLeaveBlankToKeep
                }}</small></span
              ><Input
                v-model="editing.apiKey"
                type="password"
                :placeholder="
                  editing.hasApiKey
                    ? copy.useTheSavedServerKey
                    : copy.pasteYourAPIKey
                "
                autocomplete="new-password"
                spellcheck="false"
            /></label>
          </section>
          <section class="ai-step">
            <div class="ai-step-title">
              <span>2</span>
              <h3>{{ copy.chooseAModel }}</h3>
              <Button
                variant="ghost"
                type="button"
                class="ai-refresh"
                :disabled="!canDiscover()"
                @click="discover"
                ><RefreshCw :size="13" />{{ copy.refresh }}</Button
              >
            </div>

            <div v-if="discovery === 'idle'" class="ai-discovery-state">
              <CircleHelp :size="17" />{{ copy.modelDiscoveryHint }}
            </div>

            <label v-if="models.length > 12" class="field"
              ><span>{{ copy.filterModels }}</span
              ><Input v-model="modelSearch" :placeholder="copy.searchModels"
            /></label>
            <label v-if="models.length || editing.model" class="field"
              ><span
                >{{ copy.draftingModel
                }}<small v-if="models.length">
                  · {{ models.length }} {{ copy.visibleModels }}</small
                ></span
              ><AppSelect
                v-model="editing.model"
                :options="[
                  ...(selectedOutsideList
                    ? [
                        {
                          value: editing.model!,
                          label:
                            editing.model! + ' · ' + copy.currentConfiguration,
                        },
                      ]
                    : []),
                  ...filteredModels.map((model) => ({
                    value: model.id,
                    label: model.name,
                  })),
                ]"
              /><small v-if="hasMore">{{
                copy.onlyPartOfTheLargeCatalogIsShown
              }}</small
              ><small>{{ copy.modelCompatibilityHint }}</small></label
            >
          </section>
          <CollapsibleRoot v-model:open="advanced" class="ai-advanced">
            <CollapsibleTrigger as-child>
              <Button type="button" variant="ghost" class="ai-advanced-trigger">
                <ChevronRight :size="15" :class="{ rotated: advanced }" />
                <Settings2 :size="14" />{{ copy.advancedCompatibility
                }}<span>{{ copy.usuallyUnnecessary }}</span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent class="ai-advanced-body">
              <label class="field"
                ><span>{{ copy.outputCompatibility }}</span
                ><AppSelect
                  v-model="editing.outputMode"
                  :options="[
                    {
                      value: 'auto',
                      label: copy.automaticStructuredOutput,
                    },
                    {
                      value: 'json',
                      label: copy.jSONModeGateways,
                    },
                    {
                      value: 'prompt',
                      label: copy.promptOnlyLegacy,
                    },
                  ]"
                /><small>{{ copy.outputModeHint }}</small></label
              ><label v-if="!models.length" class="field"
                ><span>{{
                  copy.fallbackModelIDOnlyIfNoCatalogIsAvailable
                }}</span
                ><Input
                  v-model="editing.model"
                  :placeholder="copy.modelId" /></label
              ><label class="ai-checkbox"
                ><AppCheckbox v-model="replaceHeaders" />{{
                  copy.replaceCustomHeaders
                }}<small v-if="editing.hasHeaders && !replaceHeaders">{{
                  copy.savedUnchanged
                }}</small></label
              ><label v-if="replaceHeaders" class="field"
                ><span>{{ copy.customHeadersClearsPreviousValues }}</span
                ><Textarea
                  v-model="customHeaders"
                  rows="3"
                  spellcheck="false"
                /><small>{{ copy.customHeadersHint }}</small></label
              >
            </CollapsibleContent>
          </CollapsibleRoot>
          <section class="ai-step ai-verification">
            <div class="ai-step-title">
              <span>3</span>
              <h3>{{ copy.verifyDrafting }}</h3>
            </div>
            <p>
              {{ copy.verificationHint }}
            </p>
            <Button
              type="submit"
              variant="outline"
              :disabled="busy || !editing.model"
              ><Check :size="15" />{{ copy.verifyCurrentConfiguration }}</Button
            >
            <Card v-if="verification" class="ai-verification-result">
              <Check :size="17" />
              <div>
                <strong>{{ copy.verificationResult }}</strong
                ><small
                  >{{ verification.model }} · {{ verification.latencyMs }}
                  {{ copy.ms }} {{ copy.nothingSent }}</small
                >
              </div>
            </Card>
          </section>
          <label class="ai-checkbox"
            ><AppCheckbox v-model="makeDefault" />{{
              copy.useAsTheDefaultDraftingServiceAfterSaving
            }}</label
          >
        </fieldset>

        <footer class="ai-dialog-footer">
          <small>{{ copy.unsavedConfigHint }}</small
          ><Button
            type="button"
            :disabled="busy || !editing.model"
            @click="saveProvider"
            >{{ copy.saveConfiguration }}</Button
          >
        </footer>
      </form>
    </DialogContent>
  </Dialog>
  <Dialog
    :open="!!deleting"
    @update:open="!$event && !busy && (deleting = undefined)"
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>{{ copy.deleteAIService }}</DialogTitle
        ><DialogDescription
          >{{ deleting?.name }} ·
          {{ copy.deleteServiceWarning }}</DialogDescription
        ></DialogHeader
      >

      <div class="actions">
        <Button
          variant="outline"
          :disabled="busy"
          @click="deleting = undefined"
          >{{ copy.cancel }}</Button
        ><Button :disabled="busy" @click="remove">{{ copy.delete }}</Button>
      </div></DialogContent
    ></Dialog
  >
</template>

<style scoped>
.ai-module {
  min-width: 0;
}
.ai-module-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  margin-bottom: 22px;
}
.ai-overline {
  font-size: 10px;
  letter-spacing: 1.5px;
  color: var(--muted-foreground);
}
.ai-module-heading h2 {
  margin-top: 7px;
  font-size: 19px;
}
.ai-module-heading p {
  font-size: 12px;
  color: var(--muted-foreground);
  margin: 7px 0 0;
}
.ai-empty {
  text-align: center;
  padding: 32px 20px;
  border: 1px dashed #dbe2ee;
  border-radius: 10px;
}
.ai-empty > svg {
  color: var(--primary);
  margin: 0 auto 12px;
}
.ai-empty h3 {
  margin: 0;
  font-size: 16px;
}
.ai-empty p {
  font-size: 13px;
  color: var(--muted-foreground);
  max-width: 340px;
  margin: 10px auto 20px;
}
.ai-provider {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  padding: 18px 0;
  border-top: 1px solid var(--border);
}
.ai-provider-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  background: var(--accent);
  border: 1px solid #e0e7ff;
  color: var(--primary);
  border-radius: 9px;
}
.ai-provider-info {
  flex: 1;
  min-width: 150px;
}
.ai-provider-title {
  display: flex;
  align-items: center;
  gap: 9px;
}
.ai-provider-info p {
  font-size: 12px;
  color: var(--muted-foreground);
  margin: 6px 0 3px;
}
.ai-provider-info small {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.ai-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--primary);
  background: var(--accent);
}
.ai-provider-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.ai-callout {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  background: var(--muted);
  padding: 12px;
  border-radius: 8px;
}
.ai-fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.ai-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 8px 0 25px;
}
.ai-presets button {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 7px;
  min-height: 44px;
  font-size: 12px;
  color: var(--muted-foreground);
  padding: 6px;
}
.ai-presets button.selected {
  border-color: var(--primary);
  background: var(--accent);
  color: var(--primary);
}
.ai-step {
  border-top: 1px solid var(--border);
  padding: 21px 0;
}
.ai-step-title {
  display: flex;
  align-items: center;
  gap: 9px;
}
.ai-step-title > span {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  color: var(--primary);
  background: var(--accent);
  border-radius: 6px;
  font-size: 11px;
  font-weight: 650;
}
.ai-step-title h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.ai-step-title > small {
  margin-left: auto;
  font-size: 11px;
}
.ai-grid {
  display: grid;
  grid-template-columns: 1fr 1.3fr;
  gap: 16px;
}
.field select {
  width: 100%;
  min-width: 0;
  height: 40px;
  border: 1px solid var(--border);
  background: var(--card);
  padding: 0 10px;
  border-radius: 6px;
  font-size: 13px;
}
.field small {
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted-foreground);
  font-weight: 400;
}
.ai-discovery-state {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
}
.ai-discovery-state > svg {
  flex-shrink: 0;
}
.ai-refresh {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 0;
  color: var(--primary);
  font-size: 11px;
  min-height: 36px;
}
.ai-advanced {
  border-top: 1px solid var(--border);
  margin-bottom: 18px;
}
.ai-advanced-trigger {
  width: 100%;
  justify-content: flex-start;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 48px;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
}
.ai-advanced-trigger .rotated {
  transform: rotate(90deg);
}
.ai-advanced-trigger > span {
  margin-left: auto;
  font-size: 10px;
}
.ai-advanced-body {
  padding: 0 14px 20px;
  background: var(--muted);
  border-radius: 8px;
  overflow: hidden;
}
.ai-checkbox {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  min-height: 44px;
  margin-top: 12px;
}
.ai-checkbox input {
  accent-color: var(--primary);
  width: 16px;
  height: 16px;
}
.ai-verification p {
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.85;
  margin: 12px 0 16px;
}
.ai-verification-result {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid #dbe3ff;
  border-radius: 8px;
  background: var(--accent);
  padding: 12px;
  margin-top: 14px;
  color: var(--primary);
}
.ai-verification-result strong {
  display: block;
  font-size: 12px;
}
.ai-verification-result small {
  display: block;
  font-size: 11px;
  margin-top: 4px;
}
.ai-dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  border-top: 1px solid var(--border);
  margin-top: 15px;
  padding-top: 20px;
}
.ai-dialog-footer small {
  font-size: 11px;
  max-width: 300px;
}
.ai-spin {
  animation: ai-spin 1s linear infinite;
}
@keyframes ai-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 600px) {
  .ai-module-heading {
    align-items: flex-start;
  }
  .ai-module-heading h2 {
    font-size: 17px;
  }
  .ai-provider-actions {
    width: 100%;
    padding-left: 50px;
  }
  .ai-grid {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .ai-presets {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ai-dialog-footer {
    align-items: flex-start;
  }
  .ai-step-title > small {
    max-width: 130px;
    text-align: right;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-spin {
    animation: none;
  }
}
</style>
