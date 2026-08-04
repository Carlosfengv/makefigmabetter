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
): InputTransferBatcher {
  let pending: EditorInputEvent[] = [];
  let frame: number | undefined;

  const flush = () => {
    if (frame !== undefined) {
      scheduler.cancel(frame);
      frame = undefined;
    }
    while (pending.length) send(pending.splice(0, MAX_INPUT_EVENTS_PER_BATCH));
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
      const previous = pending.at(-1);
      if (previous && isPointerMove(previous) && isPointerMove(event)) pending[pending.length - 1] = event;
      else pending.push(event);
      schedule();
    },
    flushWith(event) {
      pending.push(event);
      flush();
    },
    flush,
    dispose() {
      pending = [];
      if (frame !== undefined) scheduler.cancel(frame);
      frame = undefined;
    },
  };
}
