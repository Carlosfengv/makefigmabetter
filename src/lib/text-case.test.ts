import { describe, expect, it } from "vitest";
import {
  applyDocumentTextCase,
  displayBoundaryToSource,
  displayClusterToSource,
  documentTextCase,
  effectiveTextOpenTypeFeatures,
  projectDocumentTextCaseRanges,
  runtimeTextCase,
  sourceBoundaryToDisplay,
  textCaseFontVariantCaps,
  usesSmallCaps,
} from "./text-case";

describe("text case presentation", () => {
  it("maps the six Figma values without persisting ORIGINAL", () => {
    expect(documentTextCase("ORIGINAL")).toBeUndefined();
    expect(runtimeTextCase(undefined)).toBe("ORIGINAL");
    expect(runtimeTextCase(documentTextCase("UPPER"))).toBe("UPPER");
    expect(runtimeTextCase(documentTextCase("LOWER"))).toBe("LOWER");
    expect(runtimeTextCase(documentTextCase("TITLE"))).toBe("TITLE");
    expect(runtimeTextCase(documentTextCase("SMALL_CAPS"))).toBe("SMALL_CAPS");
    expect(runtimeTextCase(documentTextCase("SMALL_CAPS_FORCED"))).toBe("SMALL_CAPS_FORCED");
  });

  it("transforms Unicode presentation while retaining small-caps source semantics", () => {
    expect(applyDocumentTextCase("Straße 世界", "upper")).toBe("STRASSE 世界");
    expect(applyDocumentTextCase("ÉCOLE", "lower")).toBe("école");
    expect(applyDocumentTextCase("e\u0301cole déjà", "title")).toBe("E\u0301cole Déjà");
    expect(applyDocumentTextCase("MiXeD", "smallCaps")).toBe("MiXeD");
    expect(applyDocumentTextCase("MiXeD", "smallCapsForced")).toBe("MiXeD");
    expect(usesSmallCaps("smallCaps")).toBe(true);
    expect(usesSmallCaps("smallCapsForced")).toBe(true);
    expect(textCaseFontVariantCaps("smallCaps")).toBe("small-caps");
    expect(textCaseFontVariantCaps("smallCapsForced")).toBe("all-small-caps");
    expect(effectiveTextOpenTypeFeatures("smallCaps", { LIGA: false, SMCP: false })).toEqual({ LIGA: false, SMCP: true });
    expect(effectiveTextOpenTypeFeatures("smallCapsForced", { C2SC: false })).toEqual({ C2SC: true, SMCP: true });
  });

  it("maps expanding and contracting display scalars back to Canonical UTF-8 boundaries", () => {
    const source = "İ Kstraße";
    const projection = projectDocumentTextCaseRanges(source, [
      { start: 0, end: 2, textCase: "lower" },
      { start: 2, end: 3 },
      { start: 3, end: 6, textCase: "lower" },
      { start: 6, end: 13, textCase: "upper" },
    ]);

    expect(projection?.display).toBe("i\u0307 kSTRASSE");
    expect(projection?.boundaries).toEqual([
      { source: 0, display: 0 },
      { source: 2, display: 3 },
      { source: 3, display: 4 },
      { source: 6, display: 5 },
      { source: 7, display: 6 },
      { source: 8, display: 7 },
      { source: 9, display: 8 },
      { source: 10, display: 9 },
      { source: 12, display: 11 },
      { source: 13, display: 12 },
    ]);
    if (!projection) throw new Error("missing projection");
    expect(sourceBoundaryToDisplay(projection, 2)).toBe(3);
    expect(displayBoundaryToSource(projection, 3)).toBe(2);
    expect(displayBoundaryToSource(projection, 1)).toBeUndefined();
    expect(displayClusterToSource(projection, 1)).toBe(0);
    expect(displayClusterToSource(projection, 10)).toBe(10);
  });

  it("preserves title-case word context and rejects non-total projections", () => {
    const title = projectDocumentTextCaseRanges("straße déjà", [
      { start: 0, end: 14, textCase: "title" },
    ]);
    expect(title?.display).toBe("Straße Déjà");
    expect(title?.boundaries.at(-1)).toEqual({ source: 14, display: 14 });
    expect(projectDocumentTextCaseRanges("ab", [{ start: 1, end: 2, textCase: "upper" }])).toBeUndefined();
    expect(projectDocumentTextCaseRanges("AB", [{ start: 0, end: 2, textCase: "smallCapsForced" }])?.display).toBe("AB");
  });
});
