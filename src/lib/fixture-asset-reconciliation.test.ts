import { describe, expect, it } from "vitest";
import { createNode, type DocumentAsset } from "./editor-protocol";
import {
  fixtureAssetNeedsRegistration,
  fixtureAssetNodeCommands,
} from "./fixture-asset-reconciliation";

describe("fixture asset recovery reconciliation", () => {
  const asset: DocumentAsset = {
    assetId: "asset",
    contentHash: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 4,
  };

  it("does not register an asset already restored by the new Worker", () => {
    expect(fixtureAssetNeedsRegistration([asset], asset)).toBe(false);
    expect(fixtureAssetNeedsRegistration([], asset)).toBe(true);
    expect(fixtureAssetNeedsRegistration([], { ...asset, preRegistered: true })).toBe(false);
  });

  it("does not advance revision for an existing plain image fixture node", () => {
    const image = { ...createNode("image", 0, 0), id: "image", assetId: asset.assetId };
    expect(fixtureAssetNodeCommands([image], [image])).toEqual([]);
  });

  it("updates only a stripped Paint Stack and creates a truly missing node", () => {
    const base = { ...createNode("rectangle", 0, 0), id: "paint" };
    const stacked = {
      ...base,
      fillStack: {
        layers: [{ paint: { css: "#ff0000" }, opacity: 1, visible: true }],
      },
    };
    const missing = { ...createNode("image", 10, 10), id: "missing" };
    expect(fixtureAssetNodeCommands([base], [stacked, missing])).toEqual([
      { type: "update", id: base.id, patch: { fillStack: stacked.fillStack } },
      { type: "create", node: missing },
    ]);
    expect(fixtureAssetNodeCommands([stacked], [stacked])).toEqual([]);
  });
});
