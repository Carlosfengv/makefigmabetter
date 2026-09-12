import { describe, expect, it } from "vitest";
import { RUNTIME_UX_CONTRACT, validateRuntimeUxContract } from "./runtime-ux-contract";

describe("M0 runtime UX contract", () => {
  it("freezes the required state vocabulary for mutation, resources, stale revisions, and permission", () => {
    expect(RUNTIME_UX_CONTRACT.mutation.states).toEqual(["pending", "committed", "rolled-back"]);
    expect(RUNTIME_UX_CONTRACT.resourceTask.states).toEqual(["loading", "ready", "cancelled", "failed"]);
    expect(RUNTIME_UX_CONTRACT.resourceTask.requiredActions).toEqual(["cancel", "retry"]);
    expect(RUNTIME_UX_CONTRACT.staleRevision.requiredActions).toContain("restart-from-latest");
    expect(RUNTIME_UX_CONTRACT.permission.states).toContain("denied");
  });

  it("requires keyboard, focus, and reduced-motion behavior for Player states", () => {
    expect(RUNTIME_UX_CONTRACT.player.requiredInteractions).toEqual([
      "keyboard-navigation",
      "escape-close-overlay",
      "focus-restore",
    ]);
    expect(RUNTIME_UX_CONTRACT.player.motionModes).toContain("reduced");
    expect(() => validateRuntimeUxContract()).not.toThrow();
  });
});
