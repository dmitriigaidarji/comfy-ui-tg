// Dot-notation path helpers for reading/writing values inside a plain JSON object.
// A ComfyUI API workflow is keyed by node id, each node `{ class_type, inputs: {...} }`,
// so `6.inputs.text` addresses node "6" -> inputs -> text. Numeric segments index arrays.

function segments(path: string): string[] {
  const parts = path.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`Empty path`);
  return parts;
}

export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of segments(path)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// Set the value at a dot path, throwing if an intermediate segment is missing.
// A missing path almost always means the config is stale vs. the workflow JSON.
export function setByPath(obj: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (cur == null || typeof cur !== "object") {
      throw new Error(`Cannot set "${path}": segment "${key}" is not traversable`);
    }
    const next = (cur as Record<string, unknown>)[key];
    if (next === undefined) {
      throw new Error(`Cannot set "${path}": segment "${key}" does not exist`);
    }
    cur = next;
  }
  const last = parts[parts.length - 1]!;
  if (cur == null || typeof cur !== "object") {
    throw new Error(`Cannot set "${path}": parent is not an object`);
  }
  (cur as Record<string, unknown>)[last] = value;
}

// True if the path resolves to a defined value in obj (used for startup validation).
export function pathExists(obj: unknown, path: string): boolean {
  return getByPath(obj, path) !== undefined;
}
