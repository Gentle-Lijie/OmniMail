<script setup lang="ts">
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { computed } from "vue";
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
}>();
const model = defineModel<string>();
const selectedLabel = computed(
  () => props.options.find((option) => option.value === model.value)?.label,
);
</script>
<template>
  <Select v-model="model" :disabled="disabled">
    <SelectTrigger v-bind="$attrs"
      ><SelectValue :placeholder="placeholder">{{
        selectedLabel || placeholder
      }}</SelectValue></SelectTrigger
    >
    <SelectContent
      ><SelectItem
        v-for="option in options"
        :key="option.value"
        :value="option.value"
        :disabled="option.disabled"
        >{{ option.label }}</SelectItem
      ></SelectContent
    >
  </Select>
</template>
