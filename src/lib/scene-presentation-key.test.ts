import { describe, expect, it } from "vitest";
import { scenePresentationKey } from "./scene-presentation-key";

const identity = {
  revision: 12,
  pageId: "page-1",
  transientSceneVersion: 4,
  resourceGeneration: 7,
};

describe("scene presentation key", () => {
  it("is stable for the same complete presentation identity", () => {
    expect(scenePresentationKey(identity)).toBe(scenePresentationKey({ ...identity }));
  });

  it.each([
    ["canonical revision", { revision: 13 }],
    ["page", { pageId: "page-2" }],
    ["transient overlay", { transientSceneVersion: 5 }],
    ["same-revision resource readiness", { resourceGeneration: 8 }],
  ])("changes when %s changes", (_label, patch) => {
    expect(scenePresentationKey(identity)).not.toBe(scenePresentationKey({ ...identity, ...patch }));
  });
});
