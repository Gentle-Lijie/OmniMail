import { readFileSync } from "node:fs";
export const agentSkillNames = ["server-drafts"] as const;
export const agentSkills = agentSkillNames.map((name) => {
  const text = readFileSync(
    new URL(`./skills/${name}/SKILL.md`, import.meta.url),
    "utf8",
  );
  return { name, description: text.match(/^description: (.+)$/m)![1], text };
});
