import { describe, expect, it } from "vitest";
import type { EditorInputEvent } from "./editor-protocol";
import { createInputBatchBacklogSampler, createInputTransferBatcher } from "./input-transfer-batcher";

const move = (x: number): EditorInputEvent => ({ type: "pointer", event: "move", x, y: 1, shiftKey: false, altKey: false, button: 0 });
const wheel: EditorInputEvent = { type: "wheel", x: 4, y: 5, deltaX: 0, deltaY: 3, ctrlKey: false };
const up: EditorInputEvent = { type: "pointer", event: "up", x: 7, y: 8, shiftKey: false, altKey: false, button: 0 };

describe("transferable input batcher", () => {
  it("coalesces adjacent moves and preserves intervening wheel order", () => {
    const sent: EditorInputEvent[][] = [];
    let callback: FrameRequestCallback | undefined;
    const batcher = createInputTransferBatcher((events) => sent.push([...events]), { request(next) { callback = next; return 4; }, cancel() {} });
    batcher.enqueue(move(1));
    batcher.enqueue(move(2));
    batcher.enqueue(wheel);
    batcher.enqueue(move(3));
    batcher.enqueue(move(4));
    callback?.(16);
    expect(sent).toEqual([[move(2), wheel, move(4)]]);
  });

  it("sends the final move and an up boundary together without a stale frame", () => {
    const sent: EditorInputEvent[][] = [];
    const cancelled: number[] = [];
    const batcher = createInputTransferBatcher((events) => sent.push([...events]), { request() { return 9; }, cancel(handle) { cancelled.push(handle); } });
    batcher.enqueue(move(6));
    batcher.flushWith(up);
    batcher.dispose();
    expect(sent).toEqual([[move(6), up]]);
    expect(cancelled).toEqual([9]);
  });

  it("batches a high-frequency wheel stream into one ordered frame delivery", () => {
    const sent: EditorInputEvent[][] = [];
    let callback: FrameRequestCallback | undefined;
    const batcher = createInputTransferBatcher(
      (events) => sent.push([...events]),
      {
        request(next) {
          callback = next;
          return 12;
        },
        cancel() {},
      },
    );
    const zoomIn = { ...wheel, deltaY: -4, ctrlKey: true };
    const zoomOut = { ...wheel, deltaY: 6, ctrlKey: true };

    batcher.enqueue(zoomIn);
    batcher.enqueue(zoomOut);
    expect(sent).toEqual([]);
    callback?.(16);

    expect(sent).toEqual([[zoomIn, zoomOut]]);
  });

  it("summarizes input batch backlog without retaining raw samples", () => {
    const sampler = createInputBatchBacklogSampler(3);
    [2, 8, 4, 16].forEach((duration) => sampler.record(duration));
    expect(sampler.summary()).toEqual({ samples: 3, p50Ms: 8, p95Ms: 16, maxMs: 16 });
  });
});
