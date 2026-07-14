# Task: ComfyUI Telegram Bot (Bun + TypeScript + grammY)

## Goal
Build a Telegram bot that lets a user trigger **any of several ComfyUI workflows** by sending a message (and optionally an image) to the bot, without touching the ComfyUI web UI. Each workflow is a pre-exported ComfyUI API-format JSON, paired with a **config JSON** that declares which values inside the workflow are user-editable at runtime (prompt, image size, seed, etc.) and how they map into the workflow. The bot exposes those fields in Telegram, injects the user's values into the workflow, submits it to the ComfyUI server, waits for completion, and sends the resulting image(s) back.

## Stack
- **Runtime**: Bun (use `Bun.serve`, `Bun.file`, native `fetch`/`WebSocket` where possible instead of extra deps)
- **Language**: TypeScript (strict mode on)
- **Bot framework**: [grammY](https://grammy.dev)
- **Target**: single long-running process (polling mode for grammY, not webhook, unless told otherwise)

---

## 1. Project setup

- Init with `bun init`
- Install: `bun add grammy`
- `tsconfig.json`: strict mode, `moduleResolution: bundler` (or `nodenext`), ESM
- `.env` for secrets, loaded via `Bun.env` (no need for dotenv package, Bun reads `.env` automatically)
- `.env.example` documenting required vars (see §6)
- `.gitignore`: `.env`, `node_modules`, `/output`, `/tmp`

## 2. File/folder structure

```
/src
  index.ts               # entrypoint, creates bot, registers handlers, bot.start()
  config.ts              # env parsing & validation
  comfy/
    client.ts            # ComfyUI HTTP + WebSocket client (queuePrompt, getHistory, viewImage, uploadImage)
    workflow.ts          # applies param values into a workflow template by JSON path
    registry.ts          # discovers & loads all workflow + config pairs from /workflows
    path.ts              # getByPath / setByPath dot-notation helpers + tests
    types.ts             # types for ComfyUI prompt JSON, history response, ws messages, config schema
  bot/
    handlers.ts          # grammY message/command handlers
    session.ts           # per-user state: selected workflow + current param values
    params.ts            # render param prompts, build inline keyboards, parse & validate user input
    queue.ts             # simple in-memory job queue so requests don't collide
    progress.ts          # live status message: edits one reply in place as ComfyUI reports progress
/workflows
  <name>.json            # exported API-format ComfyUI workflow (one per workflow)
  <name>.config.json     # param config for <name>.json (see §5)
.env.example
package.json
tsconfig.json
```

Each workflow is a **pair of files sharing a base name**: `txt2img.json` (the exported ComfyUI API JSON) and `txt2img.config.json` (its param config). Dropping a new pair into `/workflows` should make a new workflow available with no code changes.

## 3. ComfyUI client (`src/comfy/client.ts`)

Implement against a ComfyUI server reachable at `COMFY_HOST` (e.g. `127.0.0.1:8188`):

- `uploadImage(file: Buffer, filename: string): Promise<{name: string, subfolder: string, type: string}>`
  → `POST /upload/image` (multipart/form-data)
- `queuePrompt(workflow: object, clientId: string): Promise<string>` (returns `prompt_id`)
  → `POST /prompt` with `{ prompt: workflow, client_id: clientId }`
- `getHistory(promptId: string): Promise<HistoryResponse>`
  → `GET /history/{prompt_id}`
- `viewImage(filename: string, subfolder: string, type: string): Promise<Uint8Array>`
  → `GET /view?filename=...&subfolder=...&type=...`
- `waitForCompletion(promptId: string, clientId: string, onProgress?: (e: ProgressEvent) => void): Promise<void>`
  → open a WebSocket to `ws://{COMFY_HOST}/ws?clientId={clientId}`, resolve when an `executing` message arrives with `data.node === null && data.prompt_id === promptId` (i.e. execution finished), or reject on an `execution_error` message for that prompt_id. Use Bun's native `WebSocket`.
  → `onProgress` fires on each `progress` frame (`{value, max, node}` — samplers report per step) and on each node transition, so callers can show a live bar. It's best-effort and can fire many times a second: throttle in the caller, never in the client.

Keep this module free of Telegram-specific logic — it should be usable standalone/testable.

## 4. Workflow templating (`src/comfy/workflow.ts` + `src/comfy/path.ts`)

The workflow JSON is **not** edited by hardcoded node IDs. Instead, the config JSON (§5) lists parameters, each carrying a **dot-notation path** into the workflow. A ComfyUI API workflow is an object keyed by node id, each node `{ class_type, inputs: { ... } }`, so a path like `6.inputs.text` addresses node `6` → `inputs` → `text`. This generalizes the user's `x.y.z.value` notation.

**`path.ts`** — small, dependency-free, unit-tested helpers:

```ts
// Traverse a dot path. Numeric segments index arrays; string segments index objects.
export function getByPath(obj: unknown, path: string): unknown;

// Set the value at a dot path, throwing if an intermediate segment is missing
// (a missing path almost always means the config is stale vs. the workflow JSON).
export function setByPath(obj: any, path: string, value: unknown): void;
```

**`workflow.ts`** — apply resolved param values into a fresh clone of the template:

```ts
export function buildPrompt(
  template: ComfyWorkflow,
  config: WorkflowConfig,
  values: Record<string, unknown>,   // user-provided values, keyed by param.key
): ComfyWorkflow {
  const wf = structuredClone(template);
  for (const p of config.params) {
    const raw = values[p.key] ?? p.default;
    if (raw === undefined || raw === "") {
      if (p.required) throw new Error(`Missing required param "${p.key}" (${p.label})`);
      continue; // leave whatever the exported workflow already had
    }
    setByPath(wf, p.path, coerceValue(p, raw)); // coerce to int/float/bool/seed per p.type
  }
  return wf;
}
```

- `seed` type: when the value is `-1` (or unset), generate a fresh random seed each run so repeated prompts don't return the cached image.
- `image` type: the value is the `name` returned by `uploadImage`; the path points at the `LoadImage` node's `inputs.image`.
- Validate at load time that every `param.path` resolves in its workflow JSON, and fail fast with the offending `<name>.config.json` + path (see §5 loader).

## 5. Workflow config schema (`<name>.config.json`)

Each config declares the workflow's metadata and its user-editable params. Every entry is a **path → value** binding (the `default` is the value written when the user doesn't override it) and is surfaced in Telegram for the user to set.

```json
{
  "name": "txt2img",
  "title": "SDXL · Text → Image",
  "description": "Generate an image from a text prompt.",
  "params": [
    {
      "key": "prompt",
      "label": "Prompt",
      "path": "6.inputs.text",
      "type": "string",
      "default": "a cinematic photo",
      "required": true,
      "source": "message"
    },
    {
      "key": "negative",
      "label": "Negative prompt",
      "path": "7.inputs.text",
      "type": "string",
      "default": "text, watermark, blurry"
    },
    {
      "key": "width",
      "label": "Width",
      "path": "5.inputs.width",
      "type": "int",
      "default": 1024,
      "min": 256, "max": 2048, "step": 64
    },
    {
      "key": "height",
      "label": "Height",
      "path": "5.inputs.height",
      "type": "int",
      "default": 1024,
      "min": 256, "max": 2048, "step": 64
    },
    {
      "key": "sampler",
      "label": "Sampler",
      "path": "3.inputs.sampler_name",
      "type": "enum",
      "default": "euler",
      "options": ["euler", "dpmpp_2m", "dpmpp_sde"]
    },
    {
      "key": "seed",
      "label": "Seed",
      "path": "3.inputs.seed",
      "type": "seed",
      "default": -1
    },
    {
      "key": "image",
      "label": "Input image",
      "path": "10.inputs.image",
      "type": "image"
    }
  ]
}
```

**Param fields:**
- `key` (required): stable id used in session state and `/set` commands.
- `label` (required): human name shown in Telegram.
- `path` (required): dot-notation path into `<name>.json` where the value is written.
- `type` (required): `string` | `int` | `float` | `bool` | `seed` | `enum` | `image`. Drives coercion, validation, and how the field is rendered in Telegram.
- `default`: value applied when the user doesn't set one (the `x.y.z.value = 5` case).
- `required`: if true, generation is blocked until the user provides it (and it has no usable default).
- `min` / `max` / `step`: numeric bounds for `int`/`float`, enforced on input.
- `options`: allowed values for `enum` (rendered as inline-keyboard buttons).
- `source`: optional hint for where the value comes from. `"message"` = a plain text message to the bot fills this param (typically the prompt); `image` params are auto-filled by an uploaded photo. Absent = set only via the params UI / `/set`.
- `hidden`: if true, the bot computes this value per run — it's kept out of `/params` and rejected by `/set`, so a user can't override it. Used by `upscale`'s `fit_scale`, which the handler derives from the source image's dimensions to hold output at 4K (see below).

**Top-level config fields** (besides `name` / `title` / `description` / `params`):
- `delivery`: `"photo"` (default) | `"document"` — how finished images are sent back. Telegram re-encodes and downscales anything sent as a photo, so workflows whose whole point is resolution (e.g. `upscale`) set `"document"` to preserve it.

**Output size cap (`upscale`)**

Cost scales with the upscaler's *output*: USDU refines it in fixed-size tiles and the VAE decodes it, so a large result is what OOMs the card. Output is capped at **3840px (4K)** on the longest side. Before queueing, `upscale()` reads the source's dimensions out of its header (`src/image.ts`, no decode) and writes a `fit_scale` into the workflow's `ImageScaleBy` node, fitting the source to `3840 / upscale_by` with the aspect ratio intact — 960px at ×4, 1920px at ×2. Anything already under that scales by 1 and passes through untouched.

Deriving the cap from `upscale_by` rather than hardcoding a source size keeps the 4K bound true whatever the multiplier is set to. The guard fails closed — an unreadable header, or an `upscale` workflow with no `fit_scale` param, is refused rather than run.

**Why `upscale_by` defaults to 2, not 4**

RealESRGAN_x4plus is a ×4 model, and USDU runs it then resizes to the requested factor. At ×4 you get its raw output, artifacts and all — visibly grainy on photos. At ×2 it runs ×4 and halves the result, averaging those artifacts out. Since the 4K cap lets a ×2 run start from a 1920px source instead of 960px, ×2 reaches the same output resolution for the same tile count, keeps twice as much real detail, and looks cleaner.

**Why `denoise` defaults to 0.4**

Krea 2 turbo is few-step distilled: it's trained to resolve noise in large jumps, and it does that poorly at low denoise, leaving visible grain in the refined tiles. 0.2 was inherited from the source workflow's upscaler group, which was disabled and had never actually been run. 0.4 gives the sampler enough to work with while staying close to the source. `steps` is at 10 on the same reasoning — 8 also looks fine, and 20 was tried but is too slow to be worth it on a per-tile sampler.

**Loader (`registry.ts`)** at startup:
- Glob `/workflows/*.config.json`; for each, load the sibling `<name>.json`.
- Parse & validate the config (Zod-style manual validation is fine): required fields present, `type` known, `enum` has `options`, numeric bounds sane.
- Assert every `param.path` resolves against its workflow JSON via `getByPath`; if not, throw a clear error naming the config file and path. **Fail fast** — a stale config should stop startup, not silently no-op.
- Build a registry `Map<name, { title, workflow, config }>`. Throw if the registry is empty.

## 6. Environment variables (`.env.example`)

```
TELEGRAM_BOT_TOKEN=
COMFY_HOST=127.0.0.1:8188
ALLOWED_USER_IDS=123456789,987654321   # comma-separated Telegram user IDs allowed to use the bot
WORKFLOWS_DIR=./workflows              # where <name>.json / <name>.config.json pairs live
DEFAULT_WORKFLOW=txt2img               # workflow selected for a user before they pick one (optional)
MAX_CONCURRENT_JOBS=1
GENERATION_TIMEOUT_MS=300000
```

- `config.ts` parses and validates these at startup, throwing a clear error if `TELEGRAM_BOT_TOKEN` is missing, and failing fast rather than starting the bot in a broken state.
- If `DEFAULT_WORKFLOW` is set it must exist in the registry (validate at startup).

## 7. Bot behavior (`src/bot/handlers.ts` + `src/bot/session.ts` + `src/bot/params.ts`)

Per-user **session** (in-memory, keyed by Telegram user id): `{ workflowName, values: Record<key, value> }`. Values persist across generations so the user tweaks one field and re-runs.

- **Access control**: reject any message from a user ID not in `ALLOWED_USER_IDS` with a polite message; log rejected attempts.
- **`/start`** → short usage instructions.
- **`/workflows`** → list available workflows (from the registry) as an inline keyboard; selecting one sets it as the user's active workflow and resets `values` to that config's defaults.
- **`/params`** → show the active workflow's params with their current effective values, plus inline buttons to edit each one (buttons for `enum`, "send me a value" prompt for the rest).
- **`/set <key> <value>`** → set one param directly (validated & coerced per its `type`/bounds); reply with the new value or a validation error.
- **`/reset`** → restore the active workflow's defaults.
- **Plain text message** → fill the param(s) with `source: "message"` (typically `prompt`). If the workflow has no `message` param, treat the text as a `/set` on the required text field. Then run.
- **Photo message (with optional caption)** → `uploadImage` to ComfyUI, set every `type: "image"` param to the returned `name`; use the caption as the `message`/prompt param if present. Then run.
- **`/run`** (or `/go`) → generate with the current session values without needing to resend the prompt.
- **Running a job**: validate required params first (if any are missing, tell the user which and stop). Post one status message and edit it in place for the life of the job (queue position → waiting on ComfyUI → live progress bar → `✅ Done in Ns`, or `❌ <error>`), call `replyWithChatAction("upload_photo")` periodically, then reply with the resulting image(s) via `ctx.replyWithPhoto`. See `bot/progress.ts`.
- On ComfyUI error or timeout: reply with a clear error message, never leave the user hanging silently.

Keep param rendering/parsing in `params.ts` so it's driven entirely by the config schema — no per-workflow hardcoding in handlers.

## 8. Queue (`src/bot/queue.ts`)

- Simple FIFO in-memory queue (array + processing flag) respecting `MAX_CONCURRENT_JOBS` (start with 1 — ComfyUI processes one prompt at a time anyway on most single-GPU setups).
- Each job: `{ id, userId, chatId, workflowName, values, resolve, reject }`.
- If queue has pending jobs when a new one arrives, reply to the user with their position in queue.

## 9. Entrypoint (`src/index.ts`)

- Parse env (`config.ts`), build the workflow registry (`registry.ts`) — both fail fast on bad input.
- Construct grammY `Bot` with token from config.
- Register handlers.
- Basic global error boundary (`bot.catch(...)`) that logs and does not crash the process.
- Graceful shutdown on `SIGINT`/`SIGTERM` (stop polling, let in-flight job finish or cancel).
- `bot.start()`.

## 10. package.json scripts

```json
{
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

## 11. Non-goals for this pass (explicitly skip unless asked)
- No database/persistence — in-memory session/state only (sessions reset on restart).
- No webhook mode — polling only.
- No per-workflow custom validation logic — validation is generic, driven by the config `type`/bounds only.
- No Docker packaging yet.

## 12. Deliverable checklist
- [ ] Project builds and typechecks (`bun run typecheck`) with no errors
- [ ] `getByPath`/`setByPath` have unit tests (`bun test`), incl. missing-path failure
- [ ] Dropping a new `<name>.json` + `<name>.config.json` pair into `/workflows` exposes a new workflow with no code changes
- [ ] Startup fails fast with a clear message when a config `path` doesn't resolve in its workflow JSON
- [ ] `/workflows` lets the user switch workflows; `/params` + `/set` let the user set exposed fields
- [ ] Sending a text message produces an image reply end-to-end against a running local ComfyUI instance
- [ ] Unauthorized user IDs are rejected
- [ ] Errors from ComfyUI (bad prompt, execution error, timeout) surface as a readable Telegram message, not a crash

---

## Open questions to resolve with the user before/while implementing
1. Share at least one real `<name>.json` (exported API-format workflow) so a matching `<name>.config.json` can be authored and the `path`s verified.
2. Which fields should be user-editable per workflow, and which stay fixed? (Fixed values can just live in the exported JSON, or be a `param` with a `default` and no `source`.)
3. Should generated images also be saved locally (`/output`) in addition to being sent to Telegram?
4. Should session state (selected workflow + values) survive a bot restart, or is in-memory fine for now?
5. Any params that need richer input than text/enum (e.g. LoRA picker, aspect-ratio presets that set width+height together)?
