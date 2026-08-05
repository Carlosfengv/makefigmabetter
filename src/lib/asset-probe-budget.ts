/** Caps bytes concurrently owned by the isolated Asset Probe Worker. */
export const MAX_ASSET_PROBE_IN_FLIGHT_BYTES = 256 * 1024 * 1024;

/**
 * Tracks only request identifiers and byte counts. It intentionally never retains
 * asset data, names, MIME declarations, or probe output.
 */
export class AssetProbeBudget {
  private readonly reservations = new Map<string, number>();
  private inFlightBytes = 0;

  constructor(private readonly limitBytes = MAX_ASSET_PROBE_IN_FLIGHT_BYTES) {}

  reserve(requestId: string, byteLength: number): boolean {
    if (!requestId || this.reservations.has(requestId) || !Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
    if (!Number.isSafeInteger(this.limitBytes) || this.limitBytes < 0 || byteLength > this.limitBytes - this.inFlightBytes) return false;
    this.reservations.set(requestId, byteLength);
    this.inFlightBytes += byteLength;
    return true;
  }

  release(requestId: string): void {
    const byteLength = this.reservations.get(requestId);
    if (byteLength === undefined) return;
    this.reservations.delete(requestId);
    this.inFlightBytes -= byteLength;
  }

  summary() {
    return { inFlightBytes: this.inFlightBytes, requestCount: this.reservations.size, limitBytes: this.limitBytes };
  }
}
