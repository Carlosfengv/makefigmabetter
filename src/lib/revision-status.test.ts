import { describe, expect, it } from "vitest";
import { statusRevisionIsCurrent } from "./revision-status";

describe("revision-bound status", () => {
  it("suppresses a late result after undo or remote hydration advanced the revision", () => {
    expect(statusRevisionIsCurrent(14, 14)).toBe(true);
    expect(statusRevisionIsCurrent(14, 13)).toBe(false);
    expect(statusRevisionIsCurrent(14, 15)).toBe(false);
  });
});
