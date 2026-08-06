import { describe, expect, it } from "vitest";
import { decodeInputBatch, encodeInputBatch, INPUT_TRANSFER_VERSION, MAX_INPUT_EVENTS_PER_BATCH } from "./input-transfer";
import type { EditorInputEvent } from "./editor-protocol";

describe("transferable input batches", () => {
  it("round-trips mixed pointer and wheel input without SharedArrayBuffer", () => {
    const events: EditorInputEvent[] = [
      { type: "pointer", event: "down", x: 10.5, y: -3.25, shiftKey: true, altKey: true, button: 0, drillDown: true, occurredAt: 123.5 },
      { type: "pointer", event: "move", x: 11.5, y: 4, shiftKey: false, altKey: false, button: -1 },
      { type: "pointer", event: "leave", x: 12, y: 5, shiftKey: false, altKey: false, button: -1 },
      { type: "wheel", x: 12, y: 6, deltaX: -7.5, deltaY: 20.25, ctrlKey: true, occurredAt: 456.25 },
    ];
    expect(decodeInputBatch(encodeInputBatch(events))).toEqual(events);
  });

  it("preserves the read-only pointer guard through transferable input", () => {
    const events: EditorInputEvent[] = [{ type: "pointer", event: "down", x: 4, y: 8, shiftKey: false, altKey: false, button: 0, readOnly: true }];
    expect(decodeInputBatch(encodeInputBatch(events))).toEqual(events);
  });

  it("rejects malformed versions, lengths, values, and oversized batches", () => {
    const unknownVersion = new ArrayBuffer(4);
    new DataView(unknownVersion).setUint8(0, INPUT_TRANSFER_VERSION + 1);
    expect(decodeInputBatch(unknownVersion)).toBeUndefined();
    expect(decodeInputBatch(new ArrayBuffer(5))).toBeUndefined();
    expect(() => encodeInputBatch(Array.from({ length: MAX_INPUT_EVENTS_PER_BATCH + 1 }, () => ({ type: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 0, ctrlKey: false } satisfies EditorInputEvent)))).toThrow("INPUT_BATCH_TOO_LARGE");
    expect(() => encodeInputBatch([{ type: "pointer", event: "move", x: Number.NaN, y: 0, shiftKey: false, altKey: false, button: 0 }])).toThrow("INPUT_COORDINATE_INVALID");
  });
});
