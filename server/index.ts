import { serverMessage } from "./i18n.js";
import { buildApp } from "./app.js";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

// Load configuration from the running directory; injected environment wins.
if (existsSync(".env")) loadEnvFile(".env");
const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
if (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))
  throw new Error(serverMessage("index.productionAPPORIGINMustUseHTTPS"));
if (!process.env.SETUP_TOKEN || process.env.SETUP_TOKEN.length < 24)
  throw new Error(
    serverMessage("index.sETUPTOKENMustContainAtLeast24Characters"),
  );
const { app, store } = await buildApp({
  secret: process.env.APP_SECRET ?? "",
  setupToken: process.env.SETUP_TOKEN,
  origin,
  dbPath: process.env.DATABASE_PATH,
});
for (const [env, key] of [
  ["OUTLOOK_MAIL_WEBHOOK_URL", "mailWebhookUrl"],
  ["OUTLOOK_EVENT_WEBHOOK_URL", "eventWebhookUrl"],
]) {
  if (process.env[env] && !store.get(key))
    store.set(key, store.encrypt(process.env[env]!));
}
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
});
console.log(
  serverMessage("index.listening", { port: process.env.PORT ?? 3000 }),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
