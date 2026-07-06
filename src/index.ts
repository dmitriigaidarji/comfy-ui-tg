import { Bot } from "grammy";
import { loadConfig } from "./config.ts";
import { loadRegistry } from "./comfy/registry.ts";
import { ComfyClient } from "./comfy/client.ts";
import { SessionStore } from "./bot/session.ts";
import { JobQueue } from "./bot/queue.ts";
import { registerHandlers } from "./bot/handlers.ts";

const cfg = loadConfig();
const registry = await loadRegistry(cfg.workflowsDir);

// Default workflow: env override, else the first discovered one.
const defaultWorkflow = cfg.defaultWorkflow ?? registry.keys().next().value!;
if (!registry.has(defaultWorkflow)) {
  throw new Error(`DEFAULT_WORKFLOW "${defaultWorkflow}" not found in ${cfg.workflowsDir}`);
}
console.log(
  `Loaded ${registry.size} workflow(s): ${[...registry.keys()].join(", ")} (default: ${defaultWorkflow})`,
);

const client = new ComfyClient(cfg.comfyHost, cfg.generationTimeoutMs);
const sessions = new SessionStore(registry, defaultWorkflow);
const queue = new JobQueue(cfg.maxConcurrentJobs);

const bot = new Bot(cfg.telegramBotToken);
registerHandlers(bot, cfg, registry, client, sessions, queue);

bot.catch((err) => {
  console.error(`Bot error while handling update ${err.ctx.update.update_id}:`, err.error);
});

const stop = (sig: string) => {
  console.log(`\n${sig} received, stopping…`);
  bot.stop();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.log("Bot starting (polling)…");
await bot.start();
