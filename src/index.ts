import { Bot } from "grammy";
import { loadConfig } from "./config.ts";
import { loadRegistry } from "./comfy/registry.ts";
import { ComfyClient } from "./comfy/client.ts";
import { SessionStore } from "./bot/session.ts";
import { JobQueue } from "./bot/queue.ts";
import { registerHandlers } from "./bot/handlers.ts";
import { log } from "./logger.ts";

const cfg = loadConfig();
const registry = await loadRegistry(cfg.workflowsDir);

// Default workflow: env override, else the first discovered one.
const defaultWorkflow = cfg.defaultWorkflow ?? registry.keys().next().value!;
if (!registry.has(defaultWorkflow)) {
  throw new Error(`DEFAULT_WORKFLOW "${defaultWorkflow}" not found in ${cfg.workflowsDir}`);
}
log.info("workflows loaded", {
  count: registry.size,
  names: [...registry.keys()].join(","),
  default: defaultWorkflow,
});
log.info("config", {
  comfyHost: cfg.comfyHost,
  allowedUsers: cfg.allowedUserIds.size,
  maxConcurrent: cfg.maxConcurrentJobs,
});
if (cfg.allowedUserIds.size === 0) {
  log.warn("ALLOWED_USER_IDS is empty — no one is authorized; set it in .env");
}

const client = new ComfyClient(cfg.comfyHost, cfg.generationTimeoutMs);
const sessions = new SessionStore(registry, defaultWorkflow);
const queue = new JobQueue(cfg.maxConcurrentJobs);

const bot = new Bot(cfg.telegramBotToken);
registerHandlers(bot, cfg, registry, client, sessions, queue);

// Populate Telegram's "/" command menu (autocomplete + menu button).
await bot.api.setMyCommands([
  { command: "start", description: "Usage instructions" },
  { command: "workflows", description: "Pick a workflow" },
  { command: "params", description: "View & edit fields" },
  { command: "set", description: "Set a field: /set <key> <value>" },
  { command: "reset", description: "Restore defaults" },
  { command: "run", description: "Generate with current settings" },
  { command: "upscale", description: "Reply to an image to upscale it" },
  { command: "status", description: "Queue status" },
]);

bot.catch((err) => {
  log.error("unhandled bot error", {
    update: err.ctx.update.update_id,
    err: err.error instanceof Error ? err.error.message : String(err.error),
  });
});

const stop = (sig: string) => {
  log.info("shutting down", { signal: sig });
  bot.stop();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

bot.start({
  onStart: (me) => log.info("bot started (polling)", { username: me.username, id: me.id }),
});
