import type {
  ComfyWorkflow,
  HistoryResponse,
  UploadImageResponse,
  WsMessage,
} from "./types.ts";

export class ComfyError extends Error {}

/** A tick of execution progress: a node started, or a running node advanced a step. */
export interface ProgressEvent {
  /** Id of the node ComfyUI is working on, or null when it isn't saying. */
  node: string | null;
  /** Steps done / total, as reported by the node (samplers count sampling steps).
   *  Absent on a plain node transition — not every node reports granular progress. */
  value?: number;
  max?: number;
}

/** HTTP + WebSocket client for a ComfyUI server. Telegram-free / standalone-testable. */
export class ComfyClient {
  constructor(
    private readonly host: string,
    private readonly timeoutMs: number,
  ) {}

  private get httpBase(): string {
    return `http://${this.host}`;
  }

  async uploadImage(file: Uint8Array, filename: string): Promise<UploadImageResponse> {
    const form = new FormData();
    form.append("image", new Blob([file]), filename);
    form.append("overwrite", "true");
    const res = await fetch(`${this.httpBase}/upload/image`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new ComfyError(`uploadImage failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as UploadImageResponse;
  }

  async queuePrompt(workflow: ComfyWorkflow, clientId: string): Promise<string> {
    const res = await fetch(`${this.httpBase}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!res.ok) {
      // ComfyUI returns a detailed validation error body on bad prompts.
      throw new ComfyError(`queuePrompt rejected: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { prompt_id?: string };
    if (!body.prompt_id) throw new ComfyError(`queuePrompt: no prompt_id in response`);
    return body.prompt_id;
  }

  async getHistory(promptId: string): Promise<HistoryResponse> {
    const res = await fetch(`${this.httpBase}/history/${promptId}`);
    if (!res.ok) {
      throw new ComfyError(`getHistory failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as HistoryResponse;
  }

  async viewImage(filename: string, subfolder: string, type: string): Promise<Uint8Array> {
    const qs = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${this.httpBase}/view?${qs}`);
    if (!res.ok) {
      throw new ComfyError(`viewImage failed: ${res.status} ${await res.text()}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Resolve when execution for `promptId` finishes, reject on execution_error or timeout.
   * Finished = an `executing` message with `data.node === null` for our prompt_id.
   *
   * `onProgress` fires on every step ComfyUI reports — often several times a second, so
   * callers must be cheap or throttle. It is best-effort: a run that reports nothing still
   * completes normally.
   */
  waitForCompletion(
    promptId: string,
    clientId: string,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}/ws?clientId=${clientId}`);

      const timer = setTimeout(() => {
        cleanup();
        reject(new ComfyError(`Generation timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
      };

      ws.addEventListener("message", (event) => {
        let msg: WsMessage;
        try {
          if (typeof event.data !== "string") return; // ignore binary preview frames
          msg = JSON.parse(event.data) as WsMessage;
        } catch {
          return;
        }
        if (msg.type === "progress") {
          const d = msg.data as ProgressEvent & { prompt_id?: string };
          // Older ComfyUI omits prompt_id on progress; the frame is addressed to our
          // clientId regardless, and a stray bar is cosmetic — so only filter when told.
          if (d.prompt_id !== undefined && d.prompt_id !== promptId) return;
          onProgress?.({ node: d.node ?? null, value: d.value, max: d.max });
          return;
        }

        // Terminal events stay strict: acting on another prompt's would end this run early.
        if (msg.data?.prompt_id !== promptId) return;

        if (msg.type === "executing") {
          if (msg.data.node === null) {
            cleanup();
            resolve();
          } else {
            // Nodes that report no steps of their own at least move the label along.
            onProgress?.({ node: msg.data.node ?? null });
          }
        } else if (msg.type === "execution_error") {
          cleanup();
          reject(
            new ComfyError(
              `ComfyUI execution error: ${msg.data.exception_message ?? "unknown"}`,
            ),
          );
        }
      });

      ws.addEventListener("error", () => {
        cleanup();
        reject(new ComfyError(`WebSocket error connecting to ${this.host}`));
      });
    });
  }
}
