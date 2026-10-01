<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import {
  isEmailAddress,
  parseRecipients,
  type RecipientToken,
} from "@/lib/recipients";
import { insertFieldToken } from "@/lib/fieldInsertion";

const props = defineProps<{
  modelValue: string;
  id?: string;
  label: string;
  readonly?: boolean;
  placeholder?: string;
  t: (zh: string, en: string) => string;
}>();
const emit = defineEmits<{ "update:modelValue": [string] }>();
const tokens = ref<RecipientToken[]>([]);
const pending = ref("");
const input = ref<HTMLTextAreaElement>();
let lastEmitted: string | undefined;

watch(
  () => props.modelValue,
  (value) => {
    if (value === lastEmitted) return;
    tokens.value = parseRecipients(value || "");
    pending.value = "";
  },
  { immediate: true },
);

function publish() {
  lastEmitted = [...tokens.value.map((token) => token.value), pending.value]
    .filter(Boolean)
    .join(";");
  emit("update:modelValue", lastEmitted);
}
function commit() {
  if (props.readonly) return;
  tokens.value.push(...parseRecipients(pending.value));
  pending.value = "";
  publish();
}
function onInput(event: Event) {
  pending.value = (event.target as HTMLTextAreaElement).value;
  const parsed = parseRecipients(pending.value);
  if (
    !(event as InputEvent).isComposing &&
    /[\s,;，；、|/\\:：]$/.test(pending.value) &&
    parsed.length &&
    parsed.every((token) => token.kind !== "invalid")
  )
    commit();
  else publish();
}
function paste(event: ClipboardEvent) {
  if (props.readonly || !event.clipboardData) return;
  event.preventDefault();
  const target = event.target as HTMLTextAreaElement;
  pending.value =
    pending.value.slice(0, target.selectionStart) +
    event.clipboardData.getData("text/plain") +
    pending.value.slice(target.selectionEnd);
  commit();
}
function remove(index: number) {
  if (props.readonly) return;
  tokens.value.splice(index, 1);
  publish();
}
async function edit(index: number) {
  if (props.readonly) return;
  commit();
  pending.value = tokens.value.splice(index, 1)[0]!.value;
  publish();
  await nextTick();
  input.value?.focus();
  input.value?.select();
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || props.readonly) return;
  if (event.key === "Enter" || (event.key === "Tab" && pending.value)) {
    if (event.key === "Enter") event.preventDefault();
    commit();
  } else if (
    event.key === "Backspace" &&
    !pending.value &&
    tokens.value.length
  ) {
    event.preventDefault();
    void edit(tokens.value.length - 1);
  }
}
async function insert(field: string) {
  if (props.readonly || input.value?.disabled) return;
  const entry = input.value;
  if (
    isEmailAddress(pending.value) &&
    entry?.selectionStart === pending.value.length &&
    entry.selectionEnd === pending.value.length
  )
    commit();
  const result = insertFieldToken(
    pending.value,
    field,
    entry?.selectionStart ?? pending.value.length,
    entry?.selectionEnd ?? pending.value.length,
  );
  pending.value = result.value;
  const complete = /^{{\s*[^{}]+?\s*}}$/.test(pending.value);
  if (complete) commit();
  publish();
  await nextTick();
  entry?.focus();
  const caret = complete ? 0 : result.caret;
  entry?.setSelectionRange(caret, caret);
}
defineExpose({ insert });
</script>

<template>
  <div
    class="recipient-input"
    :class="{ 'recipient-input-readonly': readonly }"
  >
    <span
      v-for="(token, index) in tokens"
      :key="`${index}-${token.value}`"
      class="recipient-token"
      :class="`recipient-token-${token.kind}`"
    >
      <span v-if="readonly" class="recipient-token-value">{{
        token.value
      }}</span>
      <button
        v-else
        type="button"
        class="recipient-token-value"
        :aria-label="t('编辑', 'Edit') + ' ' + token.value"
        :title="
          token.kind === 'invalid'
            ? t('未识别为邮箱，点击修改', 'Invalid email. Click to edit')
            : t('点击修改', 'Click to edit')
        "
        @click="edit(index)"
      >
        {{ token.value || t("空邮箱", "Empty email") }}
      </button>
      <button
        v-if="!readonly"
        type="button"
        class="recipient-token-remove"
        :aria-label="t('移除', 'Remove') + ' ' + token.value"
        @click="remove(index)"
      >
        <X :size="12" />
      </button>
    </span>
    <textarea
      ref="input"
      :id="id"
      :value="pending"
      :readonly="readonly"
      :aria-label="label"
      :placeholder="
        tokens.length
          ? undefined
          : placeholder ||
            t(
              '粘贴邮箱或 Outlook 收件人；支持换行、空格、逗号、分号',
              'Paste emails or Outlook recipients; separate with spaces, commas, semicolons or newlines',
            )
      "
      rows="1"
      class="recipient-entry"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @paste="paste"
      @blur="commit"
      @keydown="keydown"
    />
  </div>
</template>
