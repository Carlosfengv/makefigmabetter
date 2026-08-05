import { describe, expect, it, vi } from "vitest";
import { FontFaceRegistry, fontFamilyForAsset } from "./font-face-registry";

const assetId = "00000000-0000-4000-8000-000000000001";

describe("FontFaceRegistry", () => {
  it("loads an asset once and reuses its document-scoped family", async () => {
    const registry = new FontFaceRegistry();
    const add = vi.fn();
    const face = { load: vi.fn(async () => face) };
    const create = vi.fn(() => face);
    const bytes = new Uint8Array([1, 2]).buffer;

    await expect(registry.load(assetId, bytes, { add }, create)).resolves.toBe(fontFamilyForAsset(assetId));
    await expect(registry.load(assetId, bytes, { add }, create)).resolves.toBe(fontFamilyForAsset(assetId));

    expect(create).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(face);
    expect(registry.statusFor(assetId)).toBe("ready");
  });

  it("exposes an explicit unavailable state while preserving a fallback path", async () => {
    const registry = new FontFaceRegistry();
    const create = vi.fn(() => ({ load: async () => { throw new Error("invalid font"); } }));

    await expect(registry.load(assetId, new ArrayBuffer(0), { add: vi.fn() }, create)).resolves.toBeUndefined();
    expect(registry.familyFor(assetId)).toBeUndefined();
    expect(registry.statusFor(assetId)).toBe("unavailable");
  });
});
