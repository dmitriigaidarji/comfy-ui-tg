import type { RegisteredWorkflow } from "../comfy/types.ts";

export interface Session {
  workflowName: string;
  values: Record<string, unknown>;
  /** key of a param the bot is currently waiting for the user to type a value for. */
  awaitingKey?: string;
}

/** Seed a session's values from a workflow's defaults. */
export function defaultValues(wf: RegisteredWorkflow): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const p of wf.config.params) {
    if (p.default !== undefined) values[p.key] = p.default;
  }
  return values;
}

/** In-memory per-user session store. Resets on restart (non-goal: persistence). */
export class SessionStore {
  private sessions = new Map<number, Session>();

  constructor(
    private readonly registry: Map<string, RegisteredWorkflow>,
    private readonly defaultWorkflow: string,
  ) {}

  get(userId: number): Session {
    const existing = this.sessions.get(userId);
    if (existing) return existing;
    const wf = this.registry.get(this.defaultWorkflow)!;
    const created: Session = { workflowName: wf.name, values: defaultValues(wf) };
    this.sessions.set(userId, created);
    return created;
  }

  select(userId: number, workflowName: string): Session {
    const wf = this.registry.get(workflowName);
    if (!wf) throw new Error(`Unknown workflow "${workflowName}"`);
    const s: Session = { workflowName, values: defaultValues(wf) };
    this.sessions.set(userId, s);
    return s;
  }

  reset(userId: number): Session {
    const cur = this.get(userId);
    return this.select(userId, cur.workflowName);
  }
}
