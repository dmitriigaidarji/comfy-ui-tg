import { Bot, InputFile } from "grammy";
import type { AppConfig } from "../config.ts";
import { ComfyClient } from "../comfy/client.ts";
import { buildPrompt, coerceValue, missingRequired, ParamError } from "../comfy/workflow.ts";
import type { HistoryImageOutput, ParamDef, RegisteredWorkflow } from "../comfy/types.ts";
import { JobQueue } from "./queue.ts";
import { defaultValues, SessionStore } from "./session.ts";
import { log } from "../logger.ts";
import { fitScale, imageSize, scaledSize, type ImageSize } from "../image.ts";
import {
  boolKeyboard,
  effectiveValue,
  enumKeyboard,
  escapeMd,
  paramsKeyboard,
  renderParams,
  upscaleKeyboard,
  workflowsKeyboard,
} from "./params.ts";

let clientSeq = 0;

/** Registry name of the workflow driving the /upscale quick action. */
const UPSCALE_WORKFLOW = "upscale";

/**
 * Hard ceiling on the upscaler's longest output side: 4K. Cost tracks the *output* — USDU
 * refines it in fixed tiles and the VAE decodes it whole — so the source is fitted to
 * `MAX_OUTPUT_PX / upscale_by` rather than to a fixed size. That keeps the bound true at
 * any upscale_by (×4 ⇒ 960 source, ×2 ⇒ 1920) instead of only at the one it was tuned for.
 */
const MAX_OUTPUT_PX = 3840;

/** Hidden param wired to the ImageScaleBy that fits the source (see upscale.config.json). */
const FIT_SCALE_PARAM = "fit_scale";

/** The upscale workflow's multiplier — decides how far the source has to be fitted down. */
const UPSCALE_BY_PARAM = "upscale_by";

/** Shape of the bits of a Telegram message we pull an image out of. */
interface ImageBearing {
  message_id?: number;
  photo?: { file_id: string }[];
  document?: { file_id: string; mime_type?: string };
  reply_to_message?: ImageBearing;
}

/** file_id of a message's image: the largest photo size, or an image sent as a document. */
function imageFileId(msg: ImageBearing | undefined): string | undefined {
  const photo = msg?.photo;
  if (photo && photo.length > 0) return photo[photo.length - 1]!.file_id;
  const doc = msg?.document;
  if (doc?.mime_type?.startsWith("image/")) return doc.file_id;
  return undefined;
}

/**
 * ComfyUI's annotated filepath — LoadImage reads "sub/name.png [output]" straight from
 * the output dir, so a generated image can be re-fed losslessly without a round trip.
 */
function outputRef(im: HistoryImageOutput): string {
  const path = im.subfolder ? `${im.subfolder}/${im.filename}` : im.filename;
  return `${path} [${im.type}]`;
}

/**
 * Images this bot posted → the ComfyUI file behind them, so upscaling a generation uses
 * the original PNG instead of the JPEG Telegram re-encoded on the way out. Bounded, and
 * a miss (restart, or a user-posted photo) just falls back to the Telegram copy.
 */
const SENT_IMAGE_LIMIT = 500;
const sentImages = new Map<string, HistoryImageOutput>();

function rememberSent(chatId: number, messageId: number, im: HistoryImageOutput): void {
  sentImages.set(`${chatId}:${messageId}`, im);
  // Map iterates in insertion order, so the first key is always the oldest.
  while (sentImages.size > SENT_IMAGE_LIMIT) {
    sentImages.delete(sentImages.keys().next().value!);
  }
}

/** An image located and made available to LoadImage, plus what we know about its size. */
interface ResolvedImage {
  /** An uploaded filename, or an annotated "sub/name.png [output]" ref. */
  name: string;
  /** undefined when the header wasn't in a format we can read — never assume it's small. */
  size?: ImageSize;
}

export function registerHandlers(
  bot: Bot,
  cfg: AppConfig,
  registry: Map<string, RegisteredWorkflow>,
  client: ComfyClient,
  sessions: SessionStore,
  queue: JobQueue,
): void {
  // ---- Access control + request logging ----
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const kind = ctx.message?.text
      ? ctx.message.text.startsWith("/")
        ? "command"
        : "text"
      : ctx.message?.photo
        ? "photo"
        : ctx.message?.document
          ? "document"
          : ctx.callbackQuery
            ? "callback"
            : "update";
    const detail = ctx.message?.text ?? ctx.callbackQuery?.data ?? "";
    // Fail closed: an empty allowlist authorizes nobody.
    if (!cfg.allowedUserIds.has(userId)) {
      log.warn("rejected unauthorized user", { userId, username: ctx.from?.username ?? "?", kind });
      await ctx.reply("⛔ You are not authorized to use this bot.");
      return;
    }
    log.info("update", { userId, username: ctx.from?.username ?? "?", kind, detail });
    const t0 = Date.now();
    try {
      await next();
    } catch (err) {
      log.error("handler threw", { userId, kind, err: errMsg(err) });
      throw err;
    } finally {
      log.debug("update handled", { userId, kind, ms: Date.now() - t0 });
    }
  });

  // ---- Commands ----
  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "🎨 *ComfyUI bot*",
        "",
        "• Send a text message → used as the prompt, then generates.",
        "• Send a photo or an image file → used as the input image (if the workflow takes one).",
        "• Reply /upscale to any image in the chat, or tap 🔍 Upscale under one.",
        "• Send an image captioned `/upscale` to upscale it right away.",
        "  Send it as a *file* to skip Telegram's compression.",
        "",
        "/workflows — pick a workflow",
        "/params — view & edit fields",
        "/set `<key> <value>` — set a field",
        "/reset — restore defaults",
        "/run — generate with current settings",
        "/upscale `[prompt]` — upscale the image you replied to",
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
    const p = editableParam(wf, key);
    if (!p) return ctx.reply(`Unknown field "${key}". See /params.`);
    return applyValue(ctx, s, p, value);
  });

  bot.command("run", (ctx) => {
    const s = sessions.get(ctx.from!.id);
    return generate(ctx, registry.get(s.workflowName)!, s.values);
  });

  // ---- Upscale: reply to any image in the chat with /upscale [prompt] ----
  bot.command("upscale", async (ctx) => {
    const source = ctx.message?.reply_to_message as ImageBearing | undefined;
    if (!imageFileId(source)) {
      return ctx.reply(
        "Reply to an image with /upscale to enlarge it (optionally: /upscale `<prompt>`).",
        { parse_mode: "Markdown" },
      );
    }
    const prompt = (ctx.match ?? "").toString().trim();
    await upscale(ctx, source, prompt || undefined);
  });

  // ---- Callback queries ----

  bot.callbackQuery("upscale", async (ctx) => {
    // The button rides either on the image itself (bot output) or on a reply to it (user upload).
    const msg = ctx.callbackQuery.message as ImageBearing | undefined;
    const source = imageFileId(msg) ? msg : msg?.reply_to_message;
    if (!imageFileId(source)) {
      return ctx.answerCallbackQuery("That image is no longer available — reply to it with /upscale.");
    }
    // The button stays put: re-upscaling the same image at other settings is normal.
    await ctx.answerCallbackQuery("Upscaling…");
    await upscale(ctx, source);
  });
  bot.callbackQuery(/^wf:(.+)$/, async (ctx) => {
    const name = ctx.match![1]!;
    if (!registry.has(name)) return ctx.answerCallbackQuery("Unknown workflow");
    const s = sessions.select(ctx.from.id, name);
    const wf = registry.get(name)!;
    log.info("workflow selected", { userId: ctx.from.id, workflow: name });
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
    const p = editableParam(wf, key);
    if (!p) return ctx.answerCallbackQuery("Unknown field");
    await ctx.answerCallbackQuery();
    if (p.type === "enum") {
      return ctx.reply(`Choose ${p.label}:`, { reply_markup: enumKeyboard(p) });
    }
    if (p.type === "bool") {
      return ctx.reply(`Set ${p.label}:`, { reply_markup: boolKeyboard(p) });
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
    const p = editableParam(wf, key);
    if (!p) return ctx.answerCallbackQuery("Unknown field");
    await ctx.answerCallbackQuery();
    await applyValue(ctx, s, p, value);
  });

  // ---- Image sent as a photo or as an uncompressed file ----
  // Caption "/upscale [prompt]" upscales it outright; otherwise it feeds the active
  // workflow, or offers the upscale button when that workflow takes no image.
  bot.on(["message:photo", "message:document"], async (ctx) => {
    const msg = ctx.message as ImageBearing & { caption?: string; message_id: number };
    if (!imageFileId(msg)) {
      return ctx.reply("⚠️ That file isn't an image.");
    }

    const caption = (ctx.message.caption ?? "").trim();
    const cmd = caption.match(/^\/([A-Za-z0-9_]+)(?:@\S+)?\s*/);
    if (cmd?.[1]?.toLowerCase() === "upscale") {
      return upscale(ctx, msg, caption.slice(cmd[0].length).trim() || undefined);
    }

    const s = sessions.get(ctx.from.id);
    const wf = registry.get(s.workflowName)!;
    const imageParams = wf.config.params.filter((p) => p.type === "image");
    if (imageParams.length === 0) {
      // The active workflow can't consume it, but upscaling it is one tap away.
      if (registry.has(UPSCALE_WORKFLOW)) {
        return ctx.reply(`*${escapeMd(wf.title)}* doesn't take an input image. Upscale it instead?`, {
          parse_mode: "Markdown",
          reply_markup: upscaleKeyboard(),
          reply_parameters: { message_id: msg.message_id },
        });
      }
      return ctx.reply("This workflow doesn't take an input image. Send a text prompt instead.");
    }
    try {
      const { name } = await uploadTelegramImage(ctx, imageFileId(msg)!);
      for (const p of imageParams) s.values[p.key] = name;
    } catch (err) {
      log.error("image upload failed", { userId: ctx.from.id, err: errMsg(err) });
      return ctx.reply(`⚠️ Failed to upload image: ${errMsg(err)}`);
    }
    // A command caption is an instruction, not a prompt — don't let it leak into one.
    if (caption && !cmd) setMessageParams(s.values, wf, caption);
    await generate(ctx, wf, s.values);
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

    const filled = setMessageParams(s.values, wf, text);
    if (!filled) {
      return ctx.reply("No text field to fill for this workflow. Use /params to set fields.");
    }
    await generate(ctx, wf, s.values);
  });

  // ---- helpers ----

  /** A param the user may set by hand. Hidden ones are computed per run — off limits. */
  function editableParam(wf: RegisteredWorkflow, key: string): ParamDef | undefined {
    const p = wf.config.params.find((x) => x.key === key);
    return p?.hidden ? undefined : p;
  }

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
      log.info("param rejected", { userId: ctx.from?.id, key: p.key, reason: msg });
      return ctx.reply(`⚠️ ${msg}`);
    }
    log.info("param set", { userId: ctx.from?.id, key: p.key, value: s.values[p.key] });
    const wf = registry.get(s.workflowName)!;
    const p2 = wf.config.params.find((x) => x.key === p.key)!;
    return ctx.reply(`✅ ${escapeMd(p.label)} = ${escapeMd(String(effectiveValue(s, p2)))}`, {
      parse_mode: "Markdown",
    });
  }

  /** Write `text` into every `source: "message"` param. Returns whether any matched. */
  function setMessageParams(
    values: Record<string, unknown>,
    wf: RegisteredWorkflow,
    text: string,
  ): boolean {
    const targets = wf.config.params.filter((p) => p.source === "message");
    for (const p of targets) values[p.key] = text;
    return targets.length > 0;
  }

  /** Download a Telegram file and hand it to ComfyUI. */
  async function uploadTelegramImage(ctx: any, fileId: string): Promise<ResolvedImage> {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${cfg.telegramBotToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Keep the real extension so ComfyUI decodes it as what it actually is.
    const ext = file.file_path?.match(/\.[a-z0-9]+$/i)?.[0] ?? ".png";
    const uploaded = await client.uploadImage(bytes, `${file.file_unique_id}${ext}`);
    const size = imageSize(bytes);
    log.info("input image uploaded", { userId: ctx.from?.id, name: uploaded.name, size: fmtSize(size) });
    return { name: uploaded.name, size };
  }

  /**
   * Locate an image sitting in the chat. Prefers the ComfyUI file we generated it from
   * (lossless); otherwise pulls Telegram's copy and uploads it.
   */
  async function resolveImage(
    ctx: any,
    msg: ImageBearing | undefined,
  ): Promise<ResolvedImage | undefined> {
    const chatId = ctx.chat?.id;
    const known =
      chatId !== undefined && msg?.message_id !== undefined
        ? sentImages.get(`${chatId}:${msg.message_id}`)
        : undefined;
    if (known) {
      const ref = outputRef(known);
      // Re-read our own output for its header — it never left the box, so this is a local hop.
      const bytes = await client.viewImage(known.filename, known.subfolder, known.type);
      const size = imageSize(bytes);
      log.info("reusing comfyui output", { userId: ctx.from?.id, ref, size: fmtSize(size) });
      return { name: ref, size };
    }
    const fileId = imageFileId(msg);
    return fileId === undefined ? undefined : uploadTelegramImage(ctx, fileId);
  }

  /**
   * One-shot run of an image posted in the chat through the upscale workflow.
   * Uses the workflow's defaults, or the user's live values if they're already on it,
   * so a quick upscale never disturbs the session they were building elsewhere.
   */
  async function upscale(ctx: any, source: ImageBearing | undefined, prompt?: string): Promise<void> {
    const userId = ctx.from!.id;
    const wf = registry.get(UPSCALE_WORKFLOW);
    if (!wf) {
      await ctx.reply(`⚠️ No "${UPSCALE_WORKFLOW}" workflow is installed.`);
      return;
    }
    const imageParams = wf.config.params.filter((p) => p.type === "image");
    if (imageParams.length === 0) {
      await ctx.reply(`⚠️ "${wf.title}" takes no input image.`);
      return;
    }

    let resolved: ResolvedImage | undefined;
    try {
      resolved = await resolveImage(ctx, source);
    } catch (err) {
      log.error("image upload failed", { userId, err: errMsg(err) });
      await ctx.reply(`⚠️ Failed to upload image: ${errMsg(err)}`);
      return;
    }
    if (!resolved) {
      await ctx.reply("⚠️ Couldn't find an image on that message.");
      return;
    }
    // Fail closed: with no dimensions there's no bound on what the GPU is about to chew on.
    if (!resolved.size) {
      log.warn("upscale blocked: unreadable image header", { userId, name: resolved.name });
      await ctx.reply("⚠️ Couldn't read that image's dimensions. Send it as a PNG, JPEG or WebP.");
      return;
    }

    const s = sessions.get(userId);
    const values = s.workflowName === wf.name ? { ...s.values } : defaultValues(wf);
    for (const p of imageParams) values[p.key] = resolved.name;
    if (prompt) setMessageParams(values, wf, prompt);

    // Fit the source to whatever upscale_by leaves room for under the 4K ceiling.
    const raw = Number(values[UPSCALE_BY_PARAM]);
    const by = Number.isFinite(raw) && raw >= 1 ? raw : 1;
    const scale = fitScale(resolved.size, Math.floor(MAX_OUTPUT_PX / by));
    const fitted = scaledSize(resolved.size, scale);
    // A swapped-in workflow without the fitting node would silently drop the scale below.
    if (scale < 1 && !wf.config.params.some((p) => p.key === FIT_SCALE_PARAM)) {
      log.error("upscale blocked: workflow cannot fit its source", { userId, workflow: wf.name });
      await ctx.reply(
        `⚠️ That image is ${fmtSize(resolved.size)} and *${escapeMd(wf.title)}* has no way to shrink it.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    values[FIT_SCALE_PARAM] = scale;

    log.info("upscale requested", {
      userId,
      name: resolved.name,
      source: fmtSize(resolved.size),
      fitted: fmtSize(fitted),
      by,
    });
    if (scale < 1) {
      await ctx.reply(
        `↙️ Source ${fmtSize(resolved.size)} → ${fmtSize(fitted)}, so ×${by} = ${fmtSize(scaledSize(fitted, by))} (4K cap)`,
      );
    }
    await generate(ctx, wf, values);
  }

  async function generate(
    ctx: any,
    wf: RegisteredWorkflow,
    values: Record<string, unknown>,
  ): Promise<void> {
    const userId = ctx.from!.id;

    const missing = missingRequired(wf.config, values);
    if (missing.length > 0) {
      log.info("generate blocked: missing params", {
        userId,
        workflow: wf.name,
        missing: missing.map((p) => p.key),
      });
      return ctx.reply(
        `Missing required field(s): ${missing.map((p) => p.label).join(", ")}. Use /params.`,
      );
    }

    const { position, done } = queue.enqueue(() => runJob(ctx, wf, values));
    log.info("job enqueued", { userId, workflow: wf.name, position, waiting: queue.length });
    if (position > 0) {
      await ctx.reply(`🕒 Queued at position ${position}…`);
    } else {
      await ctx.reply("⏳ Generating…");
    }
    try {
      await done;
    } catch (err) {
      log.error("job failed", { userId, workflow: wf.name, err: errMsg(err) });
      await ctx.reply(`❌ ${errMsg(err)}`);
    }
  }

  async function runJob(
    ctx: any,
    wf: RegisteredWorkflow,
    values: Record<string, unknown>,
  ): Promise<void> {
    const userId = ctx.from!.id;
    const clientId = `comfy-bot-${process.pid}-${clientSeq++}`;
    const prompt = buildPrompt(wf.workflow, wf.config, values);
    const asDocument = wf.config.delivery === "document";
    const t0 = Date.now();

    const promptId = await client.queuePrompt(prompt, clientId);
    log.info("prompt queued to comfyui", { userId, workflow: wf.name, promptId });

    const heartbeat = setInterval(() => {
      ctx.replyWithChatAction(asDocument ? "upload_document" : "upload_photo").catch(() => {});
    }, 5000);
    try {
      await client.waitForCompletion(promptId, clientId);
    } finally {
      clearInterval(heartbeat);
    }
    log.info("generation complete", { userId, promptId, ms: Date.now() - t0 });

    const history = await client.getHistory(promptId);
    const entry = history[promptId];
    const images = entry
      ? Object.values(entry.outputs).flatMap((o) => o.images ?? [])
      : [];
    const outputs = images.filter((im) => im.type !== "temp");
    if (outputs.length === 0) {
      log.warn("no output images", { userId, promptId });
      await ctx.reply("⚠️ Finished but produced no output images.");
      return;
    }
    // Offer a one-tap upscale on results, except on the upscale workflow's own output —
    // chaining that is a deliberate act, so it goes through an explicit /upscale reply.
    const offer =
      wf.name !== UPSCALE_WORKFLOW && registry.has(UPSCALE_WORKFLOW)
        ? { reply_markup: upscaleKeyboard() }
        : {};
    for (const im of outputs) {
      const bytes = await client.viewImage(im.filename, im.subfolder, im.type);
      const file = new InputFile(bytes, im.filename);
      // Photos get re-encoded and downscaled by Telegram; documents keep full resolution.
      const sent = asDocument
        ? await ctx.replyWithDocument(file, offer)
        : await ctx.replyWithPhoto(file, offer);
      // Remember the source file so a later upscale re-reads it from ComfyUI rather than
      // whatever Telegram handed back.
      if (sent?.chat?.id !== undefined && sent?.message_id !== undefined) {
        rememberSent(sent.chat.id, sent.message_id, im);
      }
    }
    log.info("images sent", { userId, promptId, count: outputs.length, asDocument });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtSize(size: ImageSize | undefined): string {
  return size ? `${size.width}×${size.height}` : "unknown";
}
