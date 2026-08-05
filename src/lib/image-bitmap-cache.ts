/**
 * Bounded worker-owned cache for decoded image projections. It never affects
 * Canonical document state: eviction only releases recreatable ImageBitmaps.
 */
export class ImageBitmapCache<T extends { close(): void }> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private usedBytes = 0;

  constructor(readonly limitBytes: number) {}

  get size() { return this.entries.size; }
  get bytes() { return this.usedBytes; }

  has(key: string) { return this.entries.has(key); }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): boolean {
    if (!key || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.limitBytes) {
      value.close();
      return false;
    }
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.usedBytes -= previous.bytes;
      previous.value.close();
    }
    while (this.usedBytes + bytes > this.limitBytes) {
      const oldest = this.entries.entries().next().value as [string, { value: T; bytes: number }] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.usedBytes -= oldest[1].bytes;
      oldest[1].value.close();
    }
    this.entries.set(key, { value, bytes });
    this.usedBytes += bytes;
    return true;
  }

  clear() {
    this.entries.forEach((entry) => entry.value.close());
    this.entries.clear();
    this.usedBytes = 0;
  }
}
