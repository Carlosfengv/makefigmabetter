import { describe, expect, it } from "vitest";
import { migrateLegacyCoreRotationSnapshot } from "./legacy-rotation-migration";

describe("legacy presentation migration", () => {
  it("moves finite sidecar rotation and stroke values into a hashless v8 payload for WASM rehashing", () => {
    const migrated = JSON.parse(migrateLegacyCoreRotationSnapshot(JSON.stringify({ schemaVersion: 7, canonicalHash: "old", nodes: [{ id: "a" }, { id: "b" }] }), [{ id: "a", rotation: 30, stroke: "#2563eb", strokeWidth: 3 }, { id: "b", rotation: Number.NaN, stroke: "#000", strokeWidth: Number.NaN }])) as { schemaVersion: number; canonicalHash: string; nodes: Array<{ rotation?: number; stroke?: string; strokeWidth?: number }> };
    expect(migrated).toEqual({ schemaVersion: 8, canonicalHash: "", nodes: [{ id: "a", rotation: 30, stroke: "#2563eb", strokeWidth: 3 }, { id: "b" }] });
  });

  it("does not rewrite current or malformed Core snapshots", () => {
    const current = JSON.stringify({ schemaVersion: 9, canonicalHash: "current", nodes: [{ id: "a" }] });
    expect(migrateLegacyCoreRotationSnapshot(current, [{ id: "a", rotation: 30 }])).toBe(current);
    expect(JSON.parse(migrateLegacyCoreRotationSnapshot(current, [{ id: "a", rotation: 30, stroke: "transparent", strokeWidth: 0 }], true))).toEqual({ schemaVersion: 8, canonicalHash: "", nodes: [{ id: "a", rotation: 30, stroke: "#00000000", strokeWidth: 0 }] });
    expect(migrateLegacyCoreRotationSnapshot("not json", [{ id: "a", rotation: 30 }])).toBe("not json");
  });
});
