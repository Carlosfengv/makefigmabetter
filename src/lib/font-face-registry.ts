/** Runtime-only registry for document-scoped FontFace objects.
 *
 * Canonical Text stores only AssetId/face metadata. This registry intentionally
 * owns no document state: a failed load falls back at presentation time and can
 * never alter a snapshot or its hash.
 */
export type FontLoadStatus = "idle" | "loading" | "ready" | "unavailable";

export type LoadedFontFace = { load(): Promise<LoadedFontFace> };
export type FontFaceSetTarget = { add(face: LoadedFontFace): void };
export type FontFaceFactory = (family: string, source: ArrayBuffer) => LoadedFontFace;

export class FontFaceRegistry {
  private readonly families = new Map<string, string>();
  private readonly statuses = new Map<string, FontLoadStatus>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  familyFor(assetId: string): string | undefined {
    return this.families.get(assetId);
  }

  statusFor(assetId: string): FontLoadStatus {
    return this.statuses.get(assetId) ?? "idle";
  }

  async load(assetId: string, source: ArrayBuffer, target: FontFaceSetTarget | undefined, create: FontFaceFactory | undefined): Promise<string | undefined> {
    const existing = this.families.get(assetId);
    if (existing) return existing;
    const inFlight = this.pending.get(assetId);
    if (inFlight) return inFlight;
    if (!target || !create) {
      this.statuses.set(assetId, "unavailable");
      return undefined;
    }
    const family = fontFamilyForAsset(assetId);
    this.statuses.set(assetId, "loading");
    const task = create(family, source).load()
      .then((face) => {
        target.add(face);
        this.families.set(assetId, family);
        this.statuses.set(assetId, "ready");
        return family;
      })
      .catch(() => {
        this.statuses.set(assetId, "unavailable");
        return undefined;
      })
      .finally(() => this.pending.delete(assetId));
    this.pending.set(assetId, task);
    return task;
  }
}

export function fontFamilyForAsset(assetId: string): string {
  return `makefigma-asset-${assetId.replaceAll(/[^a-z0-9]/gi, "").toLowerCase()}`;
}
