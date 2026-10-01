<script setup lang="ts">
import { useMessages } from "@/lib/i18n";
import { ref, onMounted } from "vue";
import { startRegistration } from "@simplewebauthn/browser";
import AppSelect from "@/components/ui/AppSelect.vue";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import AIProviderSettings from "@/components/AIProviderSettings.vue";
import { api, idPath, type Settings, type Key } from "@/lib/api";
import { useFeedback } from "@/lib/notifications";

const copy = useMessages("settingsPage");
const props = defineProps<{
  language: string;
}>();
const emit = defineEmits<{ language: [string] }>();
const settings = ref<Settings>();
const passkeys = ref<Key[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const success = ref("");
const mailUrl = ref("");
const eventUrl = ref("");
const newPasskey = ref("");
const language = ref(props.language);
useFeedback({
  error,
  success,
  pending: () =>
    loading.value
      ? copy.value.loadingSettings
      : busy.value
        ? copy.value.updatingSettings
        : "",
  errorAction: () => ({
    label: copy.value.retry,
    run: () => run(load),
    disabled: () => busy.value,
  }),
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
  } finally {
    busy.value = false;
  }
}
async function load() {
  loading.value = true;
  try {
    const [s, p] = await Promise.all([
      api<Settings>("/settings"),
      api<Key[]>("/passkeys"),
    ]);
    settings.value = s;
    passkeys.value = p;
    language.value = s.language || props.language;
    emit("language", language.value);
  } finally {
    loading.value = false;
  }
}
async function save() {
  await run(async () => {
    if (!settings.value) return;
    const s = settings.value;
    await api("/settings", "PUT", {
      registrationEnabled: s.registrationEnabled,
      language: language.value,
      rateLimitMs: Number(s.rateLimitMs),
      prompt: s.prompt,
      ...(mailUrl.value ? { mailWebhookUrl: mailUrl.value } : {}),
      ...(eventUrl.value ? { eventWebhookUrl: eventUrl.value } : {}),
    });
    mailUrl.value = "";
    eventUrl.value = "";
    await load();
    success.value = copy.value.settingsSaved;
  });
}
const deleting = ref<{ path: string; name: string }>();
async function remove() {
  await run(async () => {
    if (!deleting.value) return;
    await api(deleting.value.path, "DELETE");
    deleting.value = undefined;
    await load();
    success.value = copy.value.deleted;
  });
}
async function addPasskey() {
  await run(async () => {
    const name = newPasskey.value;
    const options = await api<
      Parameters<typeof startRegistration>[0]["optionsJSON"]
    >("/auth/register/options", "POST", { name });
    const response = await startRegistration({ optionsJSON: options });
    await api("/auth/register/verify", "POST", { response, name });
    newPasskey.value = "";
    await load();
    success.value = copy.value.passkeyAdded;
  });
}
onMounted(() => run(load));
</script>
<template>
  <section class="page-enter">
    <div class="heading">
      <h1>{{ copy.settings }}</h1>
      <p class="muted">
        {{ copy.description }}
      </p>
    </div>

    <div class="workspace">
      <div class="stack">
        <Card v-if="settings" class="panel"
          ><h2>{{ copy.generalIntegrations }}</h2>
          <form @submit.prevent="save">
            <label class="field"
              ><span>{{ copy.language }}</span
              ><AppSelect
                v-model="language"
                :options="[
                  { value: 'zh', label: copy.chineseLanguage },
                  { value: 'en', label: copy.englishLanguage },
                ]" /></label
            ><label class="field"
              ><span>{{ copy.rateIntervalMs }}</span
              ><Input
                v-model="settings.rateLimitMs"
                type="number"
                min="0"
                required /></label
            ><label class="row mt-4"
              ><AppCheckbox v-model="settings.registrationEnabled" />{{
                copy.allowNewPasskeyRegistration
              }}</label
            >
            <label class="field"
              ><span>{{ copy.customAIInstructions }}</span
              ><Textarea
                v-model="settings.prompt"
                rows="4"
                :placeholder="copy.customInstructionsHint"
            /></label>
            <label class="field"
              ><span>{{ copy.mailWebhookURLBlankKeepsExisting }}</span
              ><Input
                v-model="mailUrl"
                type="url"
                autocomplete="off"
              /><small>{{
                settings.mailConfigured ? copy.configured : copy.notConfigured
              }}</small></label
            ><label class="field"
              ><span>{{ copy.eventWebhookURLBlankKeepsExisting }}</span
              ><Input
                v-model="eventUrl"
                type="url"
                autocomplete="off"
              /><small>{{
                settings.eventConfigured ? copy.configured : copy.notConfigured
              }}</small></label
            >
            <p class="muted text-xs">
              {{ copy.interfaceTestingHint }}
            </p>
            <div class="actions">
              <Button :disabled="busy">{{ copy.saveSettings }}</Button>
            </div>
          </form></Card
        ><Card class="panel"
          ><AIProviderSettings
            :providers="settings?.providers || []"
            :default-provider-id="settings?.defaultProviderId || ''"
            @updated="run(load)"
        /></Card>
      </div>
      <Card class="panel self-start"
        ><h2>{{ copy.passkeySecurity }}</h2>
        <form @submit.prevent="addPasskey">
          <label class="field"
            ><span>{{ copy.newPasskeyName }}</span
            ><Input
              v-model="newPasskey"
              required
              autocomplete="username" /></label
          ><Button class="mt-4" :disabled="busy || !newPasskey.trim()">{{
            copy.addPasskey
          }}</Button>
        </form>
        <div v-if="!passkeys.length && !loading" class="empty">
          {{ copy.noPasskeys }}
        </div>
        <div v-for="p in passkeys" :key="p.id" class="record row between">
          <div>
            {{ p.name }}
            <p class="muted text-xs">{{ p.createdAt }}</p>
          </div>
          <Button
            variant="outline"
            @click="
              deleting = { path: '/passkeys/' + idPath(p.id), name: p.name }
            "
            >{{ copy.delete }}</Button
          >
        </div>
        <p class="muted text-xs">
          {{ copy.passkeyDeletionWarning }}
        </p></Card
      >
    </div>
    <Dialog :open="!!deleting" @update:open="!$event && (deleting = undefined)"
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{ copy.confirmDeletion }}</DialogTitle
          ><DialogDescription
            >{{ deleting?.name }} ·
            {{ copy.thisCannotBeUndone }}</DialogDescription
          ></DialogHeader
        >

        <div class="actions">
          <Button variant="outline" @click="deleting = undefined">{{
            copy.back
          }}</Button
          ><Button variant="destructive" :disabled="busy" @click="remove">{{
            copy.confirmDelete
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </section>
</template>
