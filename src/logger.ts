// Tiny leveled logger with ISO timestamps. Set LOG_LEVEL=debug|info|warn|error (default info).

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(Bun.env.LOG_LEVEL as Level) in ORDER ? (Bun.env.LOG_LEVEL as Level) : "info"];

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const extra =
    fields && Object.keys(fields).length
      ? " " +
        Object.entries(fields)
          .map(([k, v]) => `${k}=${format(v)}`)
          .join(" ")
      : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

function format(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
