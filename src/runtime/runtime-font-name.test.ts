import { describe, expect, it } from "vitest";
import { fontFamilyForAsset } from "../lib/font-face-registry";
import {
  DEFAULT_RUNTIME_FONT_NAME,
  isRuntimeFontName,
  runtimeFontNameForReference,
  runtimeFontReferenceForName,
} from "./runtime-font-name";

const asset = {
  assetId: "00000000-0000-4000-8000-000000000042",
  contentHash: "a".repeat(64),
  mediaType: "font/ttf",
  byteLength: 128,
};

const namedAsset = {
  ...asset,
  assetId: "00000000-0000-4000-8000-000000000043",
  fontFaces: [
    {
      faceIndex: 0,
      family: "Acme Sans",
      style: "Regular",
      aliases: [{ family: "思源黑体", style: "常规" }],
    },
    { faceIndex: 1, family: "Acme Sans", style: "Bold" },
  ],
};

describe("Runtime FontName mapping", () => {
  it("maps the default Figma font to Canonical system fallback", () => {
    expect(runtimeFontReferenceForName(DEFAULT_RUNTIME_FONT_NAME, [asset])).toBeUndefined();
  });

  it("round-trips admitted asset faces without persisting family strings", () => {
    const regular = { assetId: asset.assetId, faceIndex: 0 };
    const collectionFace = { assetId: asset.assetId, faceIndex: 7 };
    expect(runtimeFontNameForReference(regular)).toEqual({ family: fontFamilyForAsset(asset.assetId), style: "Regular" });
    expect(runtimeFontNameForReference(collectionFace)).toEqual({ family: fontFamilyForAsset(asset.assetId), style: "Face 7" });
    expect(runtimeFontReferenceForName(runtimeFontNameForReference(regular), [asset])).toEqual(regular);
    expect(runtimeFontReferenceForName(runtimeFontNameForReference(collectionFace), [asset])).toEqual(collectionFace);
  });

  it("rejects malformed or unresolvable public names", () => {
    expect(isRuntimeFontName({ family: " Inter", style: "Regular" })).toBe(false);
    expect(runtimeFontReferenceForName({ family: "Unknown", style: "Regular" }, [asset])).toBeNull();
    expect(runtimeFontReferenceForName({ family: fontFamilyForAsset(asset.assetId), style: "Bold" }, [asset])).toBeNull();
  });

  it("uses admitted name-table identities for every face and resolves them reversibly", () => {
    expect(runtimeFontNameForReference({ assetId: namedAsset.assetId, faceIndex: 1 }, [namedAsset]))
      .toEqual({ family: "Acme Sans", style: "Bold" });
    expect(runtimeFontReferenceForName({ family: "Acme Sans", style: "Bold" }, [namedAsset]))
      .toEqual({ assetId: namedAsset.assetId, faceIndex: 1 });
    expect(runtimeFontReferenceForName({ family: "思源黑体", style: "常规" }, [namedAsset]))
      .toEqual({ assetId: namedAsset.assetId, faceIndex: 0 });
  });

  it("rejects ambiguous name-table identities instead of binding the wrong asset", () => {
    const duplicate = { ...namedAsset, assetId: "00000000-0000-4000-8000-000000000044" };
    expect(runtimeFontReferenceForName({ family: "Acme Sans", style: "Regular" }, [namedAsset, duplicate]))
      .toBeNull();
    expect(runtimeFontReferenceForName({ family: "思源黑体", style: "常规" }, [namedAsset, duplicate]))
      .toBeNull();
  });
});
