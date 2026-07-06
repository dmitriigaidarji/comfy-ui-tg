import { Bot, InputFile } from "grammy";
import type { AppConfig } from "../config.ts";
import { ComfyClient } from "../comfy/client.ts";
import { buildPrompt, coerceValue, missingRequired, ParamError } from "../comfy/workflow.ts";
import type { ParamDef, RegisteredWorkflow } from "../comfy/types.ts";
import { JobQueue } from "./queue.ts";
import { SessionStore } from "./session.ts";
import {
  effectiveValue,
  enumKeyboard,
  escapeMd,
  paramsKeyboard,
  renderParams,
  workflowsKeyboard,
} from "./params.ts";

let clientSeq = 0;

export function registerHandlers(
  bot: Bot,
  cfg: AppConfig,
  registry: Map<string, RegisteredWorkflow>,
  client: ComfyClient,
  sessions: SessionStore,
  queue: JobQueue,
): void {
  // ---- Access control ----
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    if (cfg.allowedUserIds.size > 0 && !cfg.allowedUserIds.has(userId)) {
      console.warn(`Rejected user ${userId} (@${ctx.from?.username ?? "?"})`);
      await ctx.reply("⛔ You are not authorized to use this bot.");
      return;
    }
    await next();
  });

  // ---- Commands ----
  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "🎨 *ComfyUI bot*",
        "",
        "• Send a text message → used as the prompt, then generates.",
        "• Send a photo → used as the input image (if the workflow takes one).",
        "",
        "/workflows — pick a workflow",
        "/params — view & edit fields",
        "/set `<key> <value>` — set a field",
        "/reset — restore defaults",
        "/run — generate with current settings",
        "/status — queue status",
      ].join("\n"),
      { parse_mode: "Markdown" },
    ),
  );

  bot.command("status", (ctx) =>
    ctx.reply(`In progress: ${queue.inProgress} · Waiting: ${queue.length}`),
  );

  bot.command("workflows", (ctx) =>
    ctx.reply("Pick a workflow:", { reply_markup: workflowsKeyboard(registry) }),
  );

  bot.command("params", (ctx) => {
    const s = sessions.get(ctx.from!.id);
    const wf = registry.get(s.workflowName)!;
    return ctx.reply(renderParams(wf, s), {
      parse_mode: "Markdown",
      reply_markup: paramsKeyboard(wf),
    });
  });

  bot.command("reset", (ctx) => {
    sessions.reset(ctx.from!.id);
    return ctx.reply("↩️ Restored defaults.");
  });

  bot.command("set", (ctx) => {
    const s = sessions.get(ctx.from!.id);
    const wf = registry.get(s.workflowName)!;
    const text = (ctx.match ?? "").toString().trim();
    const sp = text.indexOf(" ");
    if (sp === -1) return ctx.reply("Usage: /set <key> <value>");
    const key = text.slice(0, sp).trim();
    const value = text.slice(sp + 1).trim();
    const p = wf.config.params.find((x) => x.key === key);
    if (!p) return ctx.reply(`Unknown field "${key}". See /params.`);
    return applyValue(ctx, s, p, value);
  });

  bot.command("run", (ctx) => generate(ctx));

  // ---- Callback queries ----
  bot.callbackQuery(/^wf:(.+)$/, async (ctx) => {
    const name = ctx.match![1]!;
    if (!registry.has(name)) return ctx.answerCallbackQuery("Unknown workflow");
    const s = sessions.select(ctx.from.id, name);
    const wf = registry.get(name)!;
    await ctx.answerCallbackQuery(`Selected ${wf.title}`);
    await ctx.reply(renderParams(wf, s), {
      parse_mode: "Markdown",
      reply_markup: paramsKeyboard(wf),
    });
  });

  bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
    const key = ctx.match![1]!;
    const s = sessions.get(ctx.from.id);
    const wf = registry.get(s.workflowName)!;
    const p = wf.config.params.find((x) => x.key === key);
    if (!p) return ctx.answerCallbackQuery("Unknown field");
    await ctx.answerCallbackQuery();
    if (p.type === "enum") {
      return ctx.reply(`Choose ${p.label}:`, { reply_markup: enumKeyboard(p) });
    }
    s.awaitingKey = key;
    const hint = numericHint(p);
    return ctx.reply(`Send a value for *${escapeMd(p.label)}*${hint}`, {
      parse_mode: "Markdown",
    });
  });

  bot.callbackQuery(/^setval:([^:]+):(.+)$/, async (ctx) => {
    const key = ctx.match![1]!;
    const value = ctx.match![2]!;
    const s = sessions.get(ctx.from.id);
    const wf = registry.get(s.workflowName)!;
    const p = wf.config.params.find((x) => x.key === key);
    if (!p) return ctx.answerCallbackQuery("Unknown field");
    await ctx.answerCallbackQuery();
    await applyValue(ctx, s, p, value);
  });

  // ---- Photo: upload as input image, caption as prompt, then generate ----
  bot.on("message:photo", async (ctx) => {
    const s = sessions.get(ctx.from.id);
    const wf = registry.get(s.workflowName)!;
    const imageParams = wf.config.params.filter((p) => p.type === "image");
    if (imageParams.length === 0) {
      return ctx.reply("This workflow doesn't take an input image. Send a text prompt instead.");
    }
    try {
      const photos = ctx.message.photo;
      const file = await ctx.api.getFile(photos[photos.length - 1]!.file_id);
      const url = `https://api.telegram.org/file/bot${cfg.telegramBotToken}/${file.file_path}`;
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const uploaded = await client.uploadImage(bytes, `${file.file_unique_id}.png`);
      for (const p of imageParams) s.values[p.key] = uploaded.name;
    } catch (err) {
      return ctx.reply(`⚠️ Failed to upload image: ${errMsg(err)}`);
    }
    const caption = ctx.message.caption?.trim();
    if (caption) setMessageParams(s, wf, caption);
    await generate(ctx);
  });

  // ---- Text: fill awaited field, or the message param, then generate ----
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;
    const s = sessions.get(ctx.from.id);
    const wf = registry.get(s.workflowName)!;

    if (s.awaitingKey) {
      const p = wf.config.params.find((x) => x.key === s.awaitingKey);
      s.awaitingKey = undefined;
      if (p) return applyValue(ctx, s, p, text);
    }

    const filled = setMessageParams(s, wf, text);
    if (!filled) {
      return ctx.reply("No text field to fill for this workflow. Use /params to set fields.");
    }
    await generate(ctx);
  });

  // ---- helpers ----

  function numericHint(p: ParamDef): string {
    if (p.type !== "int" && p.type !== "float") return "";
    const bits: string[] = [];
    if (p.min !== undefined) bits.push(`min ${p.min}`);
    if (p.max !== undefined) bits.push(`max ${p.max}`);
    return bits.length ? ` (${bits.join(", ")})` : "";
  }

  async function applyValue(ctx: any, s: any, p: ParamDef, raw: string) {
    try {
      s.values[p.key] = coerceValue(p, raw);
    } catch (err) {
      const msg = err instanceof ParamError ? err.message : errMsg(err);
      return ctx.reply(`⚠️ ${msg}`);
    }
    const wf = registry.get(s.workflowName)!;
    const p2 = wf.config.params.find((x) => x.key === p.key)!;
    return ctx.reply(`✅ ${p.label} = ${escapeMd(String(effectiveValue(s, p2)))}`, {
      parse_mode: "Markdown",
    });
  }

  /** Write `text` into every `source: "message"` param. Returns whether any matched. */
  function setMessageParams(s: any, wf: RegisteredWorkflow, text: string): boolean {
    const targets = wf.config.params.filter((p) => p.source === "message");
    for (const p of targets) s.values[p.key] = text;
    return targets.length > 0;
  }

  async function generate(ctx: any) {
    const userId = ctx.from!.id;
    const s = sessions.get(userId);
    const wf = registry.get(s.workflowName)!;

    const missing = missingRequired(wf.config, s.values);
    if (missing.length > 0) {
      return ctx.reply(
        `Missing required field(s): ${missing.map((p) => p.label).join(", ")}. Use /params.`,
      );
    }

    const { position, done } = queue.enqueue(() => runJob(ctx, wf, s));
    if (position > 0) {
      await ctx.reply(`🕒 Queued at position ${position}…`);
    } else {
      await ctx.reply("⏳ Generating…");
    }
    try {
      await done;
    } catch (err) {
      await ctx.reply(`❌ ${errMsg(err)}`);
    }
  }

  async function runJob(ctx: any, wf: RegisteredWorkflow, s: any): Promise<void> {
    const clientId = `comfy-bot-${process.pid}-${clientSeq++}`;
    const prompt = buildPrompt(wf.workflow, wf.config, s.values);

    const promptId = await client.queuePrompt(prompt, clientId);

    const heartbeat = setInterval(() => {
      ctx.replyWithChatAction("upload_photo").catch(() => {});
    }, 5000);
    try {
      await client.waitForCompletion(promptId, clientId);
    } finally {
      clearInterval(heartbeat);
    }

    const history = await client.getHistory(promptId);
    const entry = history[promptId];
    const images = entry
      ? Object.values(entry.outputs).flatMap((o) => o.images ?? [])
      : [];
    const outputs = images.filter((im) => im.type !== "temp");
    if (outputs.length === 0) {
      await ctx.reply("⚠️ Finished but produced no output images.");
      return;
    }
    for (const im of outputs) {
      const bytes = await client.viewImage(im.filename, im.subfolder, im.type);
      await ctx.replyWithPhoto(new InputFile(bytes, im.filename));
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
