import { Glob } from "bun";
import { join } from "node:path";
import type {
  ComfyWorkflow,
  ParamDef,
  ParamType,
  RegisteredWorkflow,
  WorkflowConfig,
} from "./types.ts";
import { pathExists } from "./path.ts";

const PARAM_TYPES: ParamType[] = [
  "string",
  "int",
  "float",
  "bool",
  "seed",
  "enum",
  "image",
];

function fail(file: string, msg: string): never {
  throw new Error(`Invalid workflow config ${file}: ${msg}`);
}

function validateConfig(cfg: unknown, file: string): WorkflowConfig {
  if (typeof cfg !== "object" || cfg === null) fail(file, "not an object");
  const c = cfg as Record<string, unknown>;
  if (typeof c.name !== "string") fail(file, `"name" must be a string`);
  if (typeof c.title !== "string") fail(file, `"title" must be a string`);
  if (!Array.isArray(c.params)) fail(file, `"params" must be an array`);

  const seen = new Set<string>();
  const params: ParamDef[] = c.params.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) fail(file, `param[${i}] is not an object`);
    const p = raw as Record<string, unknown>;
    for (const req of ["key", "label", "path", "type"] as const) {
      if (typeof p[req] !== "string") fail(file, `param[${i}].${req} must be a string`);
    }
    const key = p.key as string;
    if (seen.has(key)) fail(file, `duplicate param key "${key}"`);
    seen.add(key);
    if (!PARAM_TYPES.includes(p.type as ParamType))
      fail(file, `param "${key}" has unknown type "${String(p.type)}"`);
    if (p.type === "enum" && (!Array.isArray(p.options) || p.options.length === 0))
      fail(file, `enum param "${key}" needs a non-empty "options" array`);
    return p as unknown as ParamDef;
  });

  return { name: c.name, title: c.title, description: c.description as string | undefined, params };
}

/** Discover & load every `<name>.config.json` + `<name>.json` pair. Fails fast on bad input. */
export async function loadRegistry(dir: string): Promise<Map<string, RegisteredWorkflow>> {
  const registry = new Map<string, RegisteredWorkflow>();
  const glob = new Glob("*.config.json");

  for await (const rel of glob.scan(dir)) {
    const configPath = join(dir, rel);
    const base = rel.replace(/\.config\.json$/, "");
    const workflowPath = join(dir, `${base}.json`);

    const config = validateConfig(await Bun.file(configPath).json(), configPath);

    const wfFile = Bun.file(workflowPath);
    if (!(await wfFile.exists()))
      throw new Error(`Config ${configPath} has no sibling workflow file ${workflowPath}`);
    const workflow = (await wfFile.json()) as ComfyWorkflow;

    // Every param path must resolve, or the config is stale vs. the workflow JSON.
    for (const p of config.params) {
      if (!pathExists(workflow, p.path))
        throw new Error(
          `Config ${configPath}: param "${p.key}" path "${p.path}" does not resolve in ${workflowPath}`,
        );
    }

    registry.set(config.name, { name: config.name, title: config.title, workflow, config });
  }

  if (registry.size === 0) throw new Error(`No workflows found in ${dir}`);
  return registry;
}
