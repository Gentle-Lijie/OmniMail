<script setup lang="ts">
import { CheckboxRoot, CheckboxIndicator } from "reka-ui";
import { Check } from "lucide-vue-next";
const model = defineModel<boolean>({ default: false });
defineProps<{ disabled?: boolean }>();
</script>
<template>
  <CheckboxRoot v-model="model" :disabled="disabled" class="ui-checkbox"
    ><CheckboxIndicator><Check :size="13" /></CheckboxIndicator
  ></CheckboxRoot>
</template>
