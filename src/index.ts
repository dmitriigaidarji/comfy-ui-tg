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
  allowed: cfg.allowedUserIds.size || "all",
  maxConcurrent: cfg.maxConcurrentJobs,
});

const client = new ComfyClient(cfg.comfyHost, cfg.generationTimeoutMs);
const sessions = new SessionStore(registry, defaultWorkflow);
const queue = new JobQueue(cfg.maxConcurrentJobs);

const bot = new Bot(cfg.telegramBotToken);
registerHandlers(bot, cfg, registry, client, sessions, queue);

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
