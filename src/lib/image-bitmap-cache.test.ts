import { describe, expect, it } from "vitest";
import { ImageBitmapCache } from "./image-bitmap-cache";

type Bitmap = { id: string; closes: number; close(): void };
const bitmap = (id: string): Bitmap => ({ id, closes: 0, close() { this.closes += 1; } });

describe("ImageBitmapCache", () => {
  it("evicts the least-recently-used decoded projection within its byte budget", () => {
    const cache = new ImageBitmapCache<Bitmap>(8);
    const first = bitmap("first");
    const second = bitmap("second");
    const third = bitmap("third");
    cache.set("first", first, 4);
    cache.set("second", second, 4);
    expect(cache.get("first")).toBe(first);
    cache.set("third", third, 4);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(first);
    expect(cache.get("third")).toBe(third);
    expect(second.closes).toBe(1);
    expect(cache.bytes).toBe(8);
  });

  it("rejects an over-budget projection without retaining its decoded pixels", () => {
    const cache = new ImageBitmapCache<Bitmap>(4);
    const oversized = bitmap("oversized");
    expect(cache.set("oversized", oversized, 5)).toBe(false);
    expect(oversized.closes).toBe(1);
    expect(cache.size).toBe(0);
  });
});
