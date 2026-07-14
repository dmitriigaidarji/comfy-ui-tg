import { InlineKeyboard } from "grammy";
import type { ParamDef, RegisteredWorkflow } from "../comfy/types.ts";
import type { Session } from "./session.ts";

/** The value currently in effect for a param (session override or config default). */
export function effectiveValue(session: Session, p: ParamDef): unknown {
  return session.values[p.key] ?? p.default;
}

function displayValue(session: Session, p: ParamDef): string {
  if (p.type === "seed") {
    const v = effectiveValue(session, p);
    return v === -1 || v === undefined ? "random" : String(v);
  }
  const v = effectiveValue(session, p);
  if (v === undefined || v === "") return "—";
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

/** Human-readable summary of the active workflow's params + values. */
export function renderParams(wf: RegisteredWorkflow, session: Session): string {
  const lines = wf.config.params
    .filter((p) => !p.hidden)
    .map((p) => {
      const req = p.required ? " ❗" : "";
      return `• *${escapeMd(p.label)}*${req} (\`${p.key}\`): ${escapeMd(displayValue(session, p))}`;
    });
  return `*${escapeMd(wf.title)}*\n\n${lines.join("\n")}\n\nEdit with /set \`<key> <value>\` or the buttons below.`;
}

/** Inline keyboard with one "edit" button per editable param (enum options inline). */
export function paramsKeyboard(wf: RegisteredWorkflow): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of wf.config.params) {
    if (p.type === "image" || p.hidden) continue; // image: set by sending a photo
    kb.text(`✏️ ${p.label}`, `edit:${p.key}`).row();
  }
  return kb;
}

/** Inline keyboard listing the enum options for a param. */
export function enumKeyboard(p: ParamDef): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const opt of p.options ?? []) kb.text(opt, `setval:${p.key}:${opt}`);
  return kb;
}

/** Inline keyboard with true/false buttons for a bool param. */
export function boolKeyboard(p: ParamDef): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ true", `setval:${p.key}:true`)
    .text("❌ false", `setval:${p.key}:false`);
}

/** One-tap "upscale this image" button, attached to images posted in the chat. */
export function upscaleKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔍 Upscale", "upscale");
}

/** Inline keyboard for picking a workflow. */
export function workflowsKeyboard(registry: Map<string, RegisteredWorkflow>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const wf of registry.values()) kb.text(wf.title, `wf:${wf.name}`).row();
  return kb;
}

export function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]()])/g, "\\$1");
}
