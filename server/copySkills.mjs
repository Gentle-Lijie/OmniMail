import { cpSync, mkdirSync } from "node:fs";
const destination = new URL("../dist/server/skills/", import.meta.url);
mkdirSync(destination, { recursive: true });
cpSync(new URL("./skills/", import.meta.url), destination, { recursive: true });
