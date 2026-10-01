<script setup lang="ts">
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

const props = defineProps<{
  providers: Provider[];
  defaultProviderId: string;
  t: (zh: string, en: string) => string;
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
const editing = ref<DraftConfig>();
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
const presets = [
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai-responses" as const,
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic" as const,
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "glm",
    label: "GLM / 智谱",
    protocol: "openai-chat" as const,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "custom",
    label: "自定义 / Custom",
    protocol: "openai-chat" as const,
    baseUrl: "",
  },
];
const preset = ref("custom");
const protocolName = (protocol: Provider["protocol"]) =>
  protocol === "anthropic"
    ? "Anthropic Messages"
    : protocol === "openai-chat"
      ? "OpenAI Chat Completions"
      : "OpenAI Responses";
function friendlyError(cause: unknown) {
  if (!(cause instanceof ApiError))
    return cause instanceof Error ? cause.message : String(cause);
  const descriptions: Record<string, [string, string]> = {
    key_required: [
      "请填写 API Key；更换服务域名时需要重新输入密钥。",
      "Enter an API key; changing hosts requires a new key.",
    ],
    provider_auth: [
      "认证失败，请检查密钥、API 类型与账号权限。",
      "Authentication failed. Check the key, API type and account permissions.",
    ],
    endpoint_unsupported: [
      "这个服务未提供该 API。请检查 API 类型及地址；兼容服务不一定实现模型列表。",
      "This API is not exposed by the service. Check API type and URL; compatible services may not offer model listing.",
    ],
    models_unsupported: [
      "该接口没有返回标准模型目录。可使用已保存模型，或在高级配置中补充模型。",
      "No standard model directory was returned. Use the saved model or the advanced override.",
    ],
    models_empty: [
      "此密钥没有返回可用模型，请检查账号权限。",
      "No models returned for this key. Check account access.",
    ],
    provider_timeout: [
      "上游响应超时，请稍后重试。",
      "The provider timed out. Try again later.",
    ],
    provider_rate_limit: [
      "上游限流，请稍后重试或检查账户额度。",
      "Provider rate limit reached. Check quota or try later.",
    ],
    invalid_base_url: [
      "请输入 API 基础地址，不要带查询参数。",
      "Enter an API base URL without query parameters.",
    ],
    model_required: [
      "请先从自动获取的模型中选择一个。",
      "Select a discovered model first.",
    ],
    output_invalid: [
      "模型没有返回可用的结构化草稿，可在高级配置中调整输出兼容模式。",
      "The model did not return a valid structured draft. Adjust the advanced output compatibility mode.",
    ],
    output_incomplete: [
      "模型输出被截断，验证不通过；不会应用不完整草稿。",
      "Model output was truncated. Verification failed; incomplete drafts are not applied.",
    ],
    output_refused: [
      "模型拒绝了起草请求，验证未通过。",
      "The model refused the drafting request.",
    ],
    draft_check_failed: [
      "模型未遵守起草指令，不能仅凭连接成功判断可用。",
      "The model did not follow drafting instructions; connectivity alone is insufficient.",
    ],
  };
  const description = cause.code ? descriptions[cause.code] : undefined;
  return description ? props.t(...description) : cause.message;
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
  const choice = presets.find((item) => item.id === value)!;
  editing.value.protocol = choice.protocol;
  editing.value.baseUrl = choice.baseUrl;
  editing.value.model = "";
  if (!editing.value.id)
    editing.value.name = value === "custom" ? "" : choice.label;
}
function config() {
  if (!editing.value) throw Error("No provider selected");
  let headers: Record<string, string> | undefined;
  if (replaceHeaders.value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(customHeaders.value || "{}");
    } catch {
      throw Error(
        props.t(
          "自定义请求头必须是 JSON 对象。",
          "Custom headers must be a JSON object.",
        ),
      );
    }
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      Object.values(parsed).some((value) => typeof value !== "string")
    )
      throw Error(
        props.t(
          "请求头必须为键值均是字符串的对象。",
          "Header names and values must be strings.",
        ),
      );
    headers = parsed as Record<string, string>;
  }
  const provider = editing.value;
  let name = provider.name?.trim();
  if (!name) {
    try {
      name = new URL(provider.baseUrl || "").hostname;
    } catch {
      name = "Custom AI";
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
    error.value = props.t(
      "选择模型后再保存。",
      "Choose a model before saving.",
    );
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
    success.value = props.t(
      makeDefault.value
        ? "AI 配置已保存，并设为默认起草服务。"
        : "AI 配置已保存。",
      makeDefault.value
        ? "Saved and selected as the default drafting service."
        : "AI configuration saved.",
    );
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
    success.value = props.t(
      "默认起草服务已切换。",
      "Default drafting service updated.",
    );
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
        <span class="ai-overline">AI CONNECTIONS</span>
        <h2 id="ai-module-title">
          {{ t("AI 起草服务", "AI drafting services") }}
        </h2>
        <p>
          {{
            t(
              "自动发现模型，验证真正的起草能力。",
              "Discover models automatically. Verify actual drafting capability.",
            )
          }}
        </p>
      </div>
      <Button variant="outline" :disabled="busy" @click="open()"
        ><Plus :size="16" />{{ t("添加服务", "Add service") }}</Button
      >
    </header>
    <p v-if="error && !editing && !deleting" class="notice error" role="alert">
      {{ error }}
    </p>
    <p v-if="success" class="ai-success" role="status">{{ success }}</p>
    <div v-if="!providers.length" class="ai-empty">
      <Server :size="28" />
      <h3>{{ t("连接你自己的 AI", "Connect your own AI") }}</h3>
      <p>
        {{
          t(
            "选择 API 类型，填写地址和密钥。模型目录会自动加载，无需先填模型 ID。",
            "Choose an API type, enter the endpoint and key. Models load automatically; no model ID required first.",
          )
        }}
      </p>
      <Button @click="open()"
        >{{ t("配置第一个服务", "Set up the first service")
        }}<ChevronRight :size="16"
      /></Button>
    </div>
    <div v-for="provider in providers" :key="provider.id" class="ai-provider">
      <div class="ai-provider-icon"><Server :size="19" /></div>
      <div class="ai-provider-info">
        <div class="ai-provider-title">
          <strong>{{ provider.name }}</strong
          ><span v-if="provider.id === defaultProviderId" class="ai-tag">{{
            t("默认起草", "Default")
          }}</span>
        </div>
        <p>
          {{ provider.model || t("未选择模型", "No model selected")
          }}<span> · </span>{{ protocolName(provider.protocol) }}
        </p>
        <small>{{ provider.baseUrl }}</small>
      </div>
      <div class="ai-provider-actions">
        <Button
          v-if="provider.id !== defaultProviderId"
          variant="ghost"
          :disabled="busy || !provider.model"
          @click="selectDefault(provider)"
          >{{ t("设为默认", "Use as default") }}</Button
        ><Button variant="outline" :disabled="busy" @click="open(provider)">{{
          t("管理", "Manage")
        }}</Button
        ><Button
          variant="ghost"
          :aria-label="t('删除 ' + provider.name, 'Delete ' + provider.name)"
          :disabled="busy"
          @click="deleting = provider"
          ><Trash2 :size="15"
        /></Button>
      </div>
    </div>
    <div v-if="providers.length && !defaultProviderId" class="ai-callout">
      <CircleHelp :size="16" />{{
        t(
          "请选择一个默认服务，工作台才知道使用哪个 AI。",
          "Choose a default service for the workspace.",
        )
      }}
    </div>
  </section>
  <Dialog :open="!!editing" @update:open="close">
    <DialogContent
      class="ai-config-dialog max-h-[92dvh] overflow-y-auto sm:max-w-[720px]"
    >
      <DialogHeader
        ><DialogTitle>{{
          t(
            editing?.id ? "管理 AI 服务" : "连接 AI 服务",
            editing?.id ? "Manage AI service" : "Connect an AI service",
          )
        }}</DialogTitle
        ><DialogDescription>{{
          t(
            "配置留在服务器。自动获取模型只读取目录；起草验证由你主动触发，可能产生少量费用。",
            "Configuration stays on the server. Model discovery only reads the catalog; drafting verification is explicit and may incur a small charge.",
          )
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
              >{{
                choice.id === "custom" ? t("自定义", "Custom") : choice.label
              }}</Button
            >
          </div>
          <section class="ai-step">
            <div class="ai-step-title">
              <span>1</span>
              <h3>{{ t("连接服务", "Connect") }}</h3>
              <small>{{
                t("填好后自动读取模型", "Models load automatically")
              }}</small>
            </div>
            <div class="ai-grid">
              <label class="field"
                ><span>{{ t("显示名称", "Display name") }}</span
                ><Input
                  v-model="editing.name"
                  :placeholder="t('例如：团队 GLM', 'e.g. Team GLM')"
                  autocomplete="off" /></label
              ><label class="field"
                ><span>{{ t("API 类型", "API type") }}</span
                ><AppSelect
                  v-model="editing.protocol"
                  :options="[
                    { value: 'openai-chat', label: 'OpenAI Chat Completions' },
                    { value: 'openai-responses', label: 'OpenAI Responses' },
                    { value: 'anthropic', label: 'Anthropic Messages' },
                  ]"
              /></label>
            </div>
            <label class="field"
              ><span>{{ t("API 基础地址", "API base URL") }}</span
              ><Input
                v-model="editing.baseUrl"
                type="url"
                placeholder="https://your-provider.example/v1"
                autocomplete="off"
              /><small>{{
                t(
                  "自动补全协议路径；不需要填写 /models 或推理接口。",
                  "Protocol paths are appended automatically; do not enter /models or an inference endpoint.",
                )
              }}</small></label
            >
            <label class="field"
              ><span
                >API Key
                <small v-if="editing.hasApiKey">{{
                  t("已保存 · 留空保留", "Saved · leave blank to keep")
                }}</small></span
              ><Input
                v-model="editing.apiKey"
                type="password"
                :placeholder="
                  editing.hasApiKey
                    ? t('使用服务器上已保存的密钥', 'Use the saved server key')
                    : t('粘贴你的 API Key', 'Paste your API key')
                "
                autocomplete="new-password"
                spellcheck="false"
            /></label>
          </section>
          <section class="ai-step">
            <div class="ai-step-title">
              <span>2</span>
              <h3>{{ t("选择模型", "Choose a model") }}</h3>
              <Button
                variant="ghost"
                type="button"
                class="ai-refresh"
                :disabled="!canDiscover()"
                @click="discover"
                ><RefreshCw :size="13" />{{ t("刷新目录", "Refresh") }}</Button
              >
            </div>
            <div
              v-if="discovery === 'loading'"
              class="ai-discovery-state"
              role="status"
            >
              <LoaderCircle class="ai-spin" :size="17" />{{
                t(
                  "正在读取此密钥可见的模型…",
                  "Loading models visible to this key…",
                )
              }}
            </div>
            <div v-else-if="discovery === 'idle'" class="ai-discovery-state">
              <CircleHelp :size="17" />{{
                t(
                  "填写有效地址与密钥后，模型会自动出现在这里。",
                  "Models appear automatically after entering a valid URL and key.",
                )
              }}
            </div>
            <div v-if="modelError" class="ai-model-error" role="alert">
              {{ modelError }}
              <p>
                {{
                  t(
                    "不会伪造模型列表，也不会把接口未实现误报为密钥错误。",
                    "We never fabricate a model list or treat an unsupported endpoint as an invalid key.",
                  )
                }}
              </p>
            </div>
            <label v-if="models.length > 12" class="field"
              ><span>{{ t("筛选模型", "Filter models") }}</span
              ><Input
                v-model="modelSearch"
                :placeholder="t('搜索模型名称', 'Search models')"
            /></label>
            <label v-if="models.length || editing.model" class="field"
              ><span
                >{{ t("起草模型", "Drafting model")
                }}<small v-if="models.length">
                  · {{ models.length }}
                  {{ t("个可见模型", "visible models") }}</small
                ></span
              ><AppSelect
                v-model="editing.model"
                :options="[
                  ...(selectedOutsideList
                    ? [
                        {
                          value: editing.model!,
                          label:
                            editing.model! +
                            ' · ' +
                            t('当前配置', 'Current configuration'),
                        },
                      ]
                    : []),
                  ...filteredModels.map((model) => ({
                    value: model.id,
                    label: model.name,
                  })),
                ]"
              /><small v-if="hasMore">{{
                t(
                  "目录较大，目前只展示部分模型。",
                  "Only part of the large catalog is shown.",
                )
              }}</small
              ><small>{{
                t(
                  "出现在目录中不代表适用于当前 API；下一步验证实际起草。",
                  "Catalog visibility does not prove API compatibility. Verify drafting below.",
                )
              }}</small></label
            >
          </section>
          <CollapsibleRoot v-model:open="advanced" class="ai-advanced">
            <CollapsibleTrigger as-child>
              <Button type="button" variant="ghost" class="ai-advanced-trigger">
                <ChevronRight :size="15" :class="{ rotated: advanced }" />
                <Settings2 :size="14" />{{
                  t("高级兼容配置", "Advanced compatibility")
                }}<span>{{ t("通常不需要", "Usually unnecessary") }}</span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent class="ai-advanced-body">
              <label class="field"
                ><span>{{ t("输出兼容模式", "Output compatibility") }}</span
                ><AppSelect
                  v-model="editing.outputMode"
                  :options="[
                    {
                      value: 'auto',
                      label: t(
                        '自动 · 原生结构化输出',
                        'Automatic · structured output',
                      ),
                    },
                    {
                      value: 'json',
                      label: t('JSON 模式 · 兼容网关', 'JSON mode · gateways'),
                    },
                    {
                      value: 'prompt',
                      label: t('仅提示词 · 旧接口兼容', 'Prompt only · legacy'),
                    },
                  ]"
                /><small>{{
                  t(
                    "不支持原生结构化输出时手动切换，再重新验证。不会自动重试付费请求。",
                    "Switch modes and verify again if structured output is unsupported. Paid requests are never retried automatically.",
                  )
                }}</small></label
              ><label v-if="!models.length" class="field"
                ><span>{{
                  t(
                    "模型 ID 备用输入（仅当上游不提供目录）",
                    "Fallback model ID (only if no catalog is available)",
                  )
                }}</span
                ><Input v-model="editing.model" placeholder="model-id" /></label
              ><label class="ai-checkbox"
                ><AppCheckbox v-model="replaceHeaders" />{{
                  t("替换自定义请求头", "Replace custom headers")
                }}<small v-if="editing.hasHeaders && !replaceHeaders">{{
                  t("已保存 · 保持不变", "Saved · unchanged")
                }}</small></label
              ><label v-if="replaceHeaders" class="field"
                ><span>{{
                  t(
                    "自定义 Headers · 空对象将清除旧值",
                    "Custom headers · {} clears previous values",
                  )
                }}</span
                ><Textarea
                  v-model="customHeaders"
                  rows="3"
                  spellcheck="false"
                /><small>{{
                  t(
                    "认证头按大小写不敏感方式覆盖默认值。",
                    "Authentication headers override defaults case-insensitively.",
                  )
                }}</small></label
              >
            </CollapsibleContent>
          </CollapsibleRoot>
          <section class="ai-step ai-verification">
            <div class="ai-step-title">
              <span>3</span>
              <h3>{{ t("验证起草能力", "Verify drafting") }}</h3>
            </div>
            <p>
              {{
                t(
                  "执行一次不含收件人的微型起草，检查模型是否能生成安全、可编辑的草稿。不是只让它回复 OK。",
                  "Generate a tiny draft with no recipients to check safe, editable structured output—not just an OK reply.",
                )
              }}
            </p>
            <Button
              type="submit"
              variant="outline"
              :disabled="busy || !editing.model"
              ><Check :size="15" />{{
                t("验证当前配置", "Verify current configuration")
              }}</Button
            >
            <div v-if="verification" class="ai-verified" role="status">
              <Check :size="17" />
              <div>
                <strong>{{ t("起草能力验证通过", "Drafting verified") }}</strong
                ><small
                  >{{ verification.model }} · {{ verification.latencyMs }} ms ·
                  {{ t("无发送动作", "Nothing sent") }}</small
                >
              </div>
            </div>
          </section>
          <label class="ai-checkbox"
            ><AppCheckbox v-model="makeDefault" />{{
              t(
                "保存后用作默认起草服务",
                "Use as the default drafting service after saving",
              )
            }}</label
          >
        </fieldset>
        <p v-if="error" class="notice error mt-4" role="alert">{{ error }}</p>
        <div v-if="busy" class="ai-pending" role="status">
          <LoaderCircle class="ai-spin" :size="16" />{{
            activity === "discover"
              ? t("正在自动获取模型…", "Discovering models…")
              : activity === "verify"
                ? t("正在验证真实起草能力…", "Verifying actual drafting…")
                : t("正在保存…", "Saving…")
          }}
        </div>
        <footer class="ai-dialog-footer">
          <small>{{
            t(
              "未保存的修改也可以发现模型和验证。",
              "Discovery and verification use your current, unsaved configuration.",
            )
          }}</small
          ><Button
            type="button"
            :disabled="busy || !editing.model"
            @click="saveProvider"
            >{{ t("保存配置", "Save configuration") }}</Button
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
        ><DialogTitle>{{ t("删除 AI 服务", "Delete AI service") }}</DialogTitle
        ><DialogDescription
          >{{ deleting?.name }} ·
          {{
            t(
              "删除默认服务后会选择其他已配置模型的服务。",
              "Another configured service will be selected if the default is deleted.",
            )
          }}</DialogDescription
        ></DialogHeader
      >
      <p v-if="error" class="notice error">{{ error }}</p>
      <div class="actions">
        <Button
          variant="outline"
          :disabled="busy"
          @click="deleting = undefined"
          >{{ t("取消", "Cancel") }}</Button
        ><Button :disabled="busy" @click="remove">{{
          t("确认删除", "Delete")
        }}</Button>
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
.ai-success {
  font-size: 12px;
  color: var(--primary);
  margin: 14px 0;
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
.ai-model-error {
  border-left: 2px solid var(--muted-foreground);
  font-size: 12px;
  color: var(--foreground);
  padding: 8px 12px;
  margin-top: 14px;
  background: var(--muted);
  line-height: 1.8;
}
.ai-model-error p {
  color: var(--muted-foreground);
  font-size: 11px;
  margin: 5px 0 0;
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
.ai-verified {
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
.ai-verified strong {
  display: block;
  font-size: 12px;
}
.ai-verified small {
  display: block;
  font-size: 11px;
  margin-top: 4px;
}
.ai-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--primary);
  padding: 14px 0;
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
