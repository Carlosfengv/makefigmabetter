import { describe, expect, it } from "vitest";
import { cssLineBoxBaseline } from "./text-baseline";

describe("cssLineBoxBaseline", () => {
  it("centers the font bounding box within the declared CSS line box", () => {
    expect(cssLineBoxBaseline(10, 30, { fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 8 }, 16)).toBe(27);
  });

  it("uses stable font-size proportions when a browser omits bounding metrics", () => {
    expect(cssLineBoxBaseline(0, 20, { fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }, 10)).toBe(13);
  });
});
