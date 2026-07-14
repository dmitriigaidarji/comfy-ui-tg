export interface Job<T> {
  id: string;
  userId: number;
  chatId: number;
  run: () => Promise<T>;
}

/** Simple FIFO queue honoring a concurrency limit (default 1 for single-GPU ComfyUI). */
export class JobQueue {
  private pending: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(private readonly maxConcurrent: number) {}

  get length(): number {
    return this.pending.length;
  }

  get inProgress(): number {
    return this.active;
  }

  /** Position a job enqueued right now would land in (0 = runs immediately). */
  get nextPosition(): number {
    return this.pending.length + Math.max(0, this.active - this.maxConcurrent + 1);
  }

  /** Enqueue work; resolves with its result. Returns queue position (0 = runs immediately). */
  enqueue<T>(run: () => Promise<T>): { position: number; done: Promise<T> } {
    const position = this.nextPosition;
    const done = new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await run());
        } catch (err) {
          reject(err);
        }
      });
    });
    this.drain();
    return { position, done };
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active++;
      task().finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
