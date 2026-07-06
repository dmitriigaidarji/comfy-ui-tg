export interface AppConfig {
  telegramBotToken: string;
  comfyHost: string;
  allowedUserIds: Set<number>;
  workflowsDir: string;
  defaultWorkflow?: string;
  maxConcurrentJobs: number;
  generationTimeoutMs: number;
}

function required(name: string): string {
  const v = Bun.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function loadConfig(): AppConfig {
  const allowed = (Bun.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`ALLOWED_USER_IDS: "${s}" is not an integer`);
      return n;
    });

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    comfyHost: Bun.env.COMFY_HOST ?? "127.0.0.1:8188",
    allowedUserIds: new Set(allowed),
    workflowsDir: Bun.env.WORKFLOWS_DIR ?? "./workflows",
    defaultWorkflow: Bun.env.DEFAULT_WORKFLOW || undefined,
    maxConcurrentJobs: Number(Bun.env.MAX_CONCURRENT_JOBS ?? "1"),
    generationTimeoutMs: Number(Bun.env.GENERATION_TIMEOUT_MS ?? "300000"),
  };
}
