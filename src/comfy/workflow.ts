import type { ComfyWorkflow, ParamDef, WorkflowConfig } from "./types.ts";
import { setByPath } from "./path.ts";

export class ParamError extends Error {}

/** Coerce & validate a raw user value according to a param definition. */
export function coerceValue(p: ParamDef, raw: unknown): unknown {
  switch (p.type) {
    case "string":
      return String(raw);

    case "int":
    case "float": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new ParamError(`${p.label} must be a number`);
      const val = p.type === "int" ? Math.round(n) : n;
      if (p.min !== undefined && val < p.min)
        throw new ParamError(`${p.label} must be ≥ ${p.min}`);
      if (p.max !== undefined && val > p.max)
        throw new ParamError(`${p.label} must be ≤ ${p.max}`);
      return val;
    }

    case "bool":
      if (typeof raw === "boolean") return raw;
      return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());

    case "seed": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new ParamError(`${p.label} must be a number`);
      // -1 (or negative) => random each run so ComfyUI doesn't return a cached image.
      if (n < 0) return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      return Math.round(n);
    }

    case "enum": {
      const v = String(raw);
      if (p.options && !p.options.includes(v))
        throw new ParamError(`${p.label} must be one of: ${p.options.join(", ")}`);
      return v;
    }

    case "image":
      return String(raw); // the `name` returned by uploadImage
  }
}

/** Deep-clone the template and write each param's resolved value in by path. */
export function buildPrompt(
  template: ComfyWorkflow,
  config: WorkflowConfig,
  values: Record<string, unknown>,
): ComfyWorkflow {
  const wf = structuredClone(template);
  for (const p of config.params) {
    const raw = values[p.key] ?? p.default;
    if (raw === undefined || raw === "") {
      if (p.required) throw new ParamError(`Missing required param "${p.label}"`);
      continue; // leave whatever the exported workflow already had
    }
    setByPath(wf, p.path, coerceValue(p, raw));
  }
  return wf;
}

/** Keys of params missing a usable value (for pre-run validation). */
export function missingRequired(
  config: WorkflowConfig,
  values: Record<string, unknown>,
): ParamDef[] {
  return config.params.filter((p) => {
    if (!p.required) return false;
    const v = values[p.key] ?? p.default;
    return v === undefined || v === "";
  });
}
