import type { AssetKind, AssetAdmission } from "./untrusted-asset";

export type Phase1HostileAssetCase = {
  id: string;
  kind: AssetKind;
  declaredMime: string;
  utf8?: string;
  hex?: string;
  expected: AssetAdmission;
};

/** Decodes an auditable fixture payload without accepting ambiguous encodings. */
export function phase1HostileAssetBytes(entry: Pick<Phase1HostileAssetCase, "utf8" | "hex">): Uint8Array {
  if (typeof entry.utf8 === "string" && entry.hex === undefined) return new TextEncoder().encode(entry.utf8);
  if (typeof entry.hex === "string" && entry.utf8 === undefined && /^[0-9a-f]*$/i.test(entry.hex) && entry.hex.length % 2 === 0) {
    return Uint8Array.from(entry.hex.match(/.{2}/g) ?? [], (value) => Number.parseInt(value, 16));
  }
  throw new Error("INVALID_PHASE1_ASSET_FIXTURE_PAYLOAD");
}
