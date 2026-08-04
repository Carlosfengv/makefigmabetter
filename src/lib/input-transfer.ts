import type { EditorInputEvent } from "./editor-protocol";

const HEADER_BYTES = 4;
const EVENT_BYTES = 32;
const POINTER_KIND = 1;
const WHEEL_KIND = 2;
const POINTER_EVENT_CODE = { down: 1, move: 2, up: 3 } as const;
const POINTER_EVENT_BY_CODE = { 1: "down", 2: "move", 3: "up" } as const;

/** Bounds both message allocation and the Worker decode loop for one input turn. */
export const MAX_INPUT_EVENTS_PER_BATCH = 256;
export const INPUT_TRANSFER_VERSION = 1;

/**
 * Encodes ephemeral browser input as a transferable ArrayBuffer. This is the
 * complete non-SAB path: no shared memory is required for editing.
 */
export function encodeInputBatch(events: readonly EditorInputEvent[]): ArrayBuffer {
  if (events.length > MAX_INPUT_EVENTS_PER_BATCH) throw new RangeError("INPUT_BATCH_TOO_LARGE");
  const buffer = new ArrayBuffer(HEADER_BYTES + events.length * EVENT_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, INPUT_TRANSFER_VERSION);
  view.setUint16(1, events.length, true);
  events.forEach((event, index) => {
    const offset = HEADER_BYTES + index * EVENT_BYTES;
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) throw new TypeError("INPUT_COORDINATE_INVALID");
    if (event.type === "pointer") {
      view.setUint8(offset, POINTER_KIND);
      view.setUint8(offset + 1, POINTER_EVENT_CODE[event.event]);
      view.setUint8(offset + 2, (event.shiftKey ? 1 : 0) | (event.readOnly ? 2 : 0));
      view.setInt8(offset + 3, event.button);
      view.setFloat64(offset + 4, event.x, true);
      view.setFloat64(offset + 12, event.y, true);
      return;
    }
    if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) throw new TypeError("INPUT_DELTA_INVALID");
    view.setUint8(offset, WHEEL_KIND);
    view.setUint8(offset + 2, event.ctrlKey ? 1 : 0);
    view.setFloat64(offset + 4, event.x, true);
    view.setFloat64(offset + 12, event.y, true);
    view.setFloat32(offset + 20, event.deltaX, true);
    view.setFloat32(offset + 24, event.deltaY, true);
  });
  return buffer;
}

/** Returns undefined rather than throwing for untrusted Worker message bytes. */
export function decodeInputBatch(buffer: ArrayBuffer): EditorInputEvent[] | undefined {
  if (buffer.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== INPUT_TRANSFER_VERSION) return undefined;
  const count = view.getUint16(1, true);
  if (count > MAX_INPUT_EVENTS_PER_BATCH || buffer.byteLength !== HEADER_BYTES + count * EVENT_BYTES) return undefined;
  const events: EditorInputEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * EVENT_BYTES;
    const type = view.getUint8(offset);
    const flags = view.getUint8(offset + 2);
    const x = view.getFloat64(offset + 4, true);
    const y = view.getFloat64(offset + 12, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || flags > (type === POINTER_KIND ? 3 : 1)) return undefined;
    if (type === POINTER_KIND) {
      const event = POINTER_EVENT_BY_CODE[view.getUint8(offset + 1) as keyof typeof POINTER_EVENT_BY_CODE];
      if (!event) return undefined;
      events.push({ type: "pointer", event, x, y, shiftKey: (flags & 1) === 1, button: view.getInt8(offset + 3), ...(flags & 2 ? { readOnly: true } : {}) });
      continue;
    }
    if (type === WHEEL_KIND) {
      const deltaX = view.getFloat32(offset + 20, true);
      const deltaY = view.getFloat32(offset + 24, true);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return undefined;
      events.push({ type: "wheel", x, y, deltaX, deltaY, ctrlKey: flags === 1 });
      continue;
    }
    return undefined;
  }
  return events;
}
