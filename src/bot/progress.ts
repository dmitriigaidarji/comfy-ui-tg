import type { ProgressEvent } from "../comfy/client.ts";
import type { ComfyWorkflow } from "../comfy/types.ts";

/** Min gap between edits of a status message: Telegram throttles rapid edits per chat. */
const EDIT_INTERVAL_MS = 3000;
const BAR_WIDTH = 12;

interface Target {
  chatId: number;
  messageId: number;
}

/**
 * One chat message tracking one job: posted once, then edited in place as ComfyUI reports
 * progress. Ticks arrive per sampler step (many per second), so edits are coalesced to the
 * latest text and rate-limited. Every failure is swallowed and edits are serialized — a
 * status line must never take a generation down or land out of order.
 */
export class StatusMessage {
  private readonly target: Promise<Target | undefined>;
  private chain: Promise<void> = Promise.resolve();
  private shown: string;
  private pending?: string;
  private lastEdit = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly ctx: any,
    initial: string,
  ) {
    this.shown = initial;
    this.target = ctx
      .reply(initial)
      .then((m: any) => ({ chatId: m.chat.id, messageId: m.message_id }))
      .catch(() => undefined);
  }

  /** Queue `text` for display. Cheap and safe to call on every websocket tick. */
  set(text: string): void {
    if (this.closed) return;
    this.pending = text;
    this.schedule();
  }

  /** Write `text` as the final state and stop accepting updates. */
  async close(text: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    await this.edit(text);
  }

  private schedule(): void {
    if (this.timer || this.pending === undefined) return;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const text = this.pending;
      this.pending = undefined;
      if (text !== undefined) void this.edit(text);
    }, wait);
  }

  private edit(text: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (text === this.shown) return;
      const target = await this.target;
      if (!target) return;
      try {
        await this.ctx.api.editMessageText(target.chatId, target.messageId, text);
        this.shown = text;
      } catch {
        // Deleted, rate-limited, or otherwise unhappy — the next tick catches up.
      }
      this.lastEdit = Date.now();
      this.schedule();
    });
    return this.chain;
  }
}

export function progressBar(fraction: number, width = BAR_WIDTH): string {
  const f = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(f * width);
  return `${"▓".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(f * 100)}%`;
}

/** Human label for a node id: its workflow title, else its class, else the raw id. */
export function nodeLabel(workflow: ComfyWorkflow, nodeId: string | null): string {
  if (!nodeId) return "Working";
  const node = workflow[nodeId];
  return node?._meta?.title?.trim() || node?.class_type || `node ${nodeId}`;
}

/** Status text for one progress tick. Plain text — node titles are user-authored. */
export function renderProgress(
  workflow: ComfyWorkflow,
  event: ProgressEvent,
  startedAt: number,
): string {
  const label = nodeLabel(workflow, event.node);
  const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
  if (event.value !== undefined && event.max !== undefined && event.max > 0) {
    return `⏳ ${label} · ${event.value}/${event.max}\n${progressBar(event.value / event.max)} · ${elapsed}`;
  }
  return `⏳ ${label} · ${elapsed}`;
}
