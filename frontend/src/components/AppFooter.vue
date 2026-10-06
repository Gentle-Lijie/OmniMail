<script setup lang="ts">
import { useMessages } from "@/lib/i18n";
import { Github } from "lucide-vue-next";

const copy = useMessages("appFooter");
</script>

<template>
  <footer class="app-footer">
    <span>
      {{ copy.attribution }}
      <a
        href="https://github.com/Gentle-Lijie"
        target="_blank"
        rel="noopener noreferrer"
        >{{ copy.author }}</a
      >
    </span>
    <a
      class="github-link"
      href="https://github.com/Gentle-Lijie/OmniMail"
      target="_blank"
      rel="noopener noreferrer"
      ><Github :size="14" aria-hidden="true" />{{ copy.repository }}</a
    >
  </footer>
</template>

<style scoped>
.app-footer {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px 16px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 11px;
  line-height: 1.5;
}
.app-footer.auth-footer {
  margin-top: 20px;
  padding: 0;
  border-top: 0;
  background: transparent;
}
.app-footer a {
  color: inherit;
  text-decoration: none;
}
.app-footer a:hover {
  color: var(--foreground);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.github-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
</style>
