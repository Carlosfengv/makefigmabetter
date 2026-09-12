import { describe, expect, it } from "vitest";
import { documentFontFamilyChain } from "./document-font-family-chain";

const font = (assetId: string) => ({ assetId, faceIndex: 0 });

describe("document font family chain", () => {
  it("keeps the loaded primary and fallback order while de-duplicating an asset", () => {
    const families = new Map([["primary", "Primary"], ["fallback", "Fallback"]]);
    expect(documentFontFamilyChain(font("primary"), [font("fallback"), font("primary")], (assetId) => families.get(assetId))).toBe('"Primary", "Fallback"');
  });

  it("skips an unavailable document asset and safely quotes a runtime family", () => {
    expect(documentFontFamilyChain(font("missing"), [font("loaded")], (assetId) => assetId === "loaded" ? 'Fall"back' : undefined)).toBe('"Fall\\"back"');
  });
});
