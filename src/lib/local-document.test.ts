import { describe, expect, it } from "vitest";
import { applyViewportRecord } from "./local-document";
import type { CoreLocalSnapshot, ViewportRecord } from "./editor-protocol";

const snapshot: CoreLocalSnapshot = { format: "rust-core-v1", coreRevision: 4, documentHash: "same-core", coreSnapshot: "{}", viewport: { x: 0, y: 0, zoom: 1 }, presentation: [] };
const record: ViewportRecord = { format: "viewport-record-v1", coreRevision: 4, documentHash: "same-core", viewport: { x: 20, y: -4, zoom: 1.5 } };

describe("viewport record recovery", () => {
  it("restores a viewport only for the matching Core hash and revision", () => {
    expect(applyViewportRecord(snapshot, record).viewport).toEqual(record.viewport);
    expect(applyViewportRecord(snapshot, { ...record, documentHash: "other" })).toBe(snapshot);
    expect(applyViewportRecord(snapshot, { ...record, coreRevision: 5 })).toBe(snapshot);
  });

  it("leaves a Core document untouched when a viewport write is absent or stale", () => {
    expect(applyViewportRecord(snapshot, undefined)).toBe(snapshot);
  });
});
