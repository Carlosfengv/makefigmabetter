import type { EditorInputEvent } from "./editor-protocol";
import { MAX_INPUT_EVENTS_PER_BATCH } from "./input-transfer";

export interface InputTransferBatcher {
  enqueue(event: EditorInputEvent): void;
  /** Appends a non-coalescable input boundary and sends the ordered batch now. */
  flushWith(event: EditorInputEvent): void;
  flush(): void;
  dispose(): void;
}

export interface InputTransferScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface InputBatchBacklogSummary { samples: number; p50Ms: number; p95Ms: number; maxMs: number; }

export function createInputBatchBacklogSampler(capacity = 240) {
  const samples: number[] = [];
  return {
    record(durationMs: number) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      samples.push(durationMs);
      if (samples.length > capacity) samples.splice(0, samples.length - capacity);
    },
    reset() { samples.length = 0; },
    summary(): InputBatchBacklogSummary {
      if (!samples.length) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
      const sorted = [...samples].sort((left, right) => left - right);
      const at = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
      return { samples: samples.length, p50Ms: round(at(.5)), p95Ms: round(at(.95)), maxMs: round(sorted.at(-1) ?? 0) };
    },
  };
}

function isPointerMove(event: EditorInputEvent): event is Extract<EditorInputEvent, { type: "pointer" }> {
  return event.type === "pointer" && event.event === "move";
}

/**
 * Batches ordinary transferable input once per animation frame. Adjacent Pointer
 * Move records collapse to their latest position; Wheel and boundary records keep
 * their exact order. This never relies on SharedArrayBuffer for correctness.
 */
export function createInputTransferBatcher(
  send: (events: readonly EditorInputEvent[]) => void,
  scheduler: InputTransferScheduler = {
    request: (callback) => globalThis.requestAnimationFrame(callback),
    cancel: (handle) => globalThis.cancelAnimationFrame(handle),
  },
  onBatchBacklog?: (durationMs: number) => void,
): InputTransferBatcher {
  let pending: EditorInputEvent[] = [];
  let frame: number | undefined;
  let firstEnqueuedAt: number | undefined;

  const flush = () => {
    if (frame !== undefined) {
      scheduler.cancel(frame);
      frame = undefined;
    }
    const enqueuedAt = firstEnqueuedAt;
    while (pending.length) send(pending.splice(0, MAX_INPUT_EVENTS_PER_BATCH));
    if (enqueuedAt !== undefined) onBatchBacklog?.(Math.max(0, performance.now() - enqueuedAt));
    firstEnqueuedAt = undefined;
  };

  const schedule = () => {
    if (frame !== undefined) return;
    frame = scheduler.request(() => {
      frame = undefined;
      flush();
    });
  };

  return {
    enqueue(event) {
      firstEnqueuedAt ??= performance.now();
      const previous = pending.at(-1);
      if (previous && isPointerMove(previous) && isPointerMove(event)) pending[pending.length - 1] = event;
      else pending.push(event);
      schedule();
    },
    flushWith(event) {
      firstEnqueuedAt ??= performance.now();
      pending.push(event);
      flush();
    },
    flush,
    dispose() {
      pending = [];
      firstEnqueuedAt = undefined;
      if (frame !== undefined) scheduler.cancel(frame);
      frame = undefined;
    },
  };
}

function round(value: number) { return Math.round(value * 1000) / 1000; }
