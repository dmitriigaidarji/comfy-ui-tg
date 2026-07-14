import { test, expect } from "bun:test";
import type { ComfyWorkflow } from "../comfy/types.ts";
import { nodeLabel, progressBar, renderProgress, StatusMessage } from "./progress.ts";

const workflow: ComfyWorkflow = {
  "3": { class_type: "KSampler", inputs: {}, _meta: { title: "Sampler" } },
  "8": { class_type: "VAEDecode", inputs: {} },
};

test("nodeLabel prefers the node title, then its class", () => {
  expect(nodeLabel(workflow, "3")).toBe("Sampler");
  expect(nodeLabel(workflow, "8")).toBe("VAEDecode");
  expect(nodeLabel(workflow, "99")).toBe("node 99");
  expect(nodeLabel(workflow, null)).toBe("Working");
});

test("progressBar fills proportionally and clamps", () => {
  expect(progressBar(0, 4)).toBe("░░░░ 0%");
  expect(progressBar(0.5, 4)).toBe("▓▓░░ 50%");
  expect(progressBar(1, 4)).toBe("▓▓▓▓ 100%");
  expect(progressBar(2, 4)).toBe("▓▓▓▓ 100%");
  expect(progressBar(-1, 4)).toBe("░░░░ 0%");
});

test("renderProgress shows steps when the node reports them", () => {
  const text = renderProgress(workflow, { node: "3", value: 5, max: 20 }, Date.now());
  expect(text).toStartWith("⏳ Sampler · 5/20\n");
  expect(text).toContain("25%");
});

test("renderProgress falls back to a bare label without step counts", () => {
  expect(renderProgress(workflow, { node: "8" }, Date.now())).toStartWith("⏳ VAEDecode ·");
});

// A max of 0 would otherwise divide to NaN and render "NaN%".
test("renderProgress ignores a zero max", () => {
  const text = renderProgress(workflow, { node: "3", value: 0, max: 0 }, Date.now());
  expect(text).not.toContain("NaN");
  expect(text).toStartWith("⏳ Sampler ·");
});

/** Records what a StatusMessage posts and edits, standing in for grammy's ctx. */
function fakeCtx() {
  const edits: string[] = [];
  return {
    edits,
    ctx: {
      reply: () => Promise.resolve({ chat: { id: 1 }, message_id: 2 }),
      api: {
        editMessageText: (_c: number, _m: number, text: string) => {
          edits.push(text);
          return Promise.resolve();
        },
      },
    },
  };
}

test("StatusMessage coalesces a burst into one edit carrying the newest text", async () => {
  const { ctx, edits } = fakeCtx();
  const status = new StatusMessage(ctx as any, "start");
  for (let i = 1; i <= 50; i++) status.set(`tick ${i}`);
  await Bun.sleep(10);
  // Intermediate ticks are stale the moment the next one lands — only the newest is worth an edit.
  expect(edits).toEqual(["tick 50"]);
  await status.close("done");
  expect(edits).toEqual(["tick 50", "done"]);
});

// A job that finishes inside the throttle window should just say so, not flash a stale bar.
test("StatusMessage skips progress entirely when close beats the throttle", async () => {
  const { ctx, edits } = fakeCtx();
  const status = new StatusMessage(ctx as any, "start");
  status.set("tick 1");
  await status.close("done");
  expect(edits).toEqual(["done"]);
});

test("StatusMessage stops editing after close", async () => {
  const { ctx, edits } = fakeCtx();
  const status = new StatusMessage(ctx as any, "start");
  await status.close("done");
  status.set("late");
  await Bun.sleep(10);
  expect(edits).toEqual(["done"]);
});

test("StatusMessage survives a failing edit", async () => {
  const ctx = {
    reply: () => Promise.resolve({ chat: { id: 1 }, message_id: 2 }),
    api: { editMessageText: () => Promise.reject(new Error("429 rate limited")) },
  };
  const status = new StatusMessage(ctx as any, "start");
  status.set("tick");
  await status.close("done");
});

test("StatusMessage survives a message that never posted", async () => {
  const ctx = {
    reply: () => Promise.reject(new Error("blocked by user")),
    api: {
      editMessageText: () => {
        throw new Error("must not edit a message that was never posted");
      },
    },
  };
  const status = new StatusMessage(ctx as any, "start");
  status.set("tick");
  await status.close("done");
});
