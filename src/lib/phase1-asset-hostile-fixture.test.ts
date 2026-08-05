import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/assets/phase1-asset-hostile.fixture.json";
import { probeUntrustedAsset } from "./asset-probe";
import { phase1HostileAssetBytes, type Phase1HostileAssetCase } from "./phase1-asset-hostile-fixture";

describe("F-ASSET-HOSTILE", () => {
  it("replays every audited hostile input through the isolated admission boundary", () => {
    expect(fixture.format).toBe("makefigma-phase1-asset-fixture-v1");
    expect(fixture.name).toBe("F-ASSET-HOSTILE");
    expect(fixture.cases).toHaveLength(6);
    for (const entry of fixture.cases as Phase1HostileAssetCase[]) {
      expect(probeUntrustedAsset({ kind: entry.kind, declaredMime: entry.declaredMime, bytes: phase1HostileAssetBytes(entry) }).admission).toEqual(entry.expected);
    }
  });

  it("rejects ambiguous fixture encodings before they reach a parser", () => {
    expect(() => phase1HostileAssetBytes({ utf8: "text", hex: "74657874" })).toThrow("INVALID_PHASE1_ASSET_FIXTURE_PAYLOAD");
    expect(() => phase1HostileAssetBytes({ hex: "not-hex" })).toThrow("INVALID_PHASE1_ASSET_FIXTURE_PAYLOAD");
  });
});
