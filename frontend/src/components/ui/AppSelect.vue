<script setup lang="ts">
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
defineOptions({ inheritAttrs: false });
defineProps<{
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
}>();
const model = defineModel<string>();
</script>
<template>
  <Select v-model="model" :disabled="disabled">
    <SelectTrigger v-bind="$attrs"
      ><SelectValue :placeholder="placeholder"
    /></SelectTrigger>
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
