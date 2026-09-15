import { describe, expect, it } from "vitest";
import { firstAvailableResource, LatestResourceLoad } from "./latest-resource-load";

describe("LatestResourceLoad", () => {
  it("accepts only the newest completion for each resource", () => {
    const loads = new LatestResourceLoad();
    const first = loads.begin("image-a");
    const other = loads.begin("image-b");
    const replacement = loads.begin("image-a");

    expect(loads.isCurrent("image-a", first)).toBe(false);
    expect(loads.isCurrent("image-a", replacement)).toBe(true);
    expect(loads.isCurrent("image-b", other)).toBe(true);
  });

  it("keeps a failed newest attempt authoritative over an older late success", () => {
    const loads = new LatestResourceLoad();
    const oldDecode = loads.begin("image-a");
    loads.begin("image-a"); // This replacement fails without publishing.

    expect(loads.isCurrent("image-a", oldDecode)).toBe(false);
  });

  it("does not let a fast cache miss beat an in-flight delivery", async () => {
    let deliver!: (value: string) => void;
    const delivered = new Promise<string>((resolve) => { deliver = resolve; });
    const result = firstAvailableResource(Promise.resolve(undefined), delivered);

    deliver("font-bytes");

    await expect(result).resolves.toBe("font-bytes");
  });

  it("uses a cache hit without waiting for delivery", async () => {
    const delivered = new Promise<string>(() => {});

    await expect(firstAvailableResource(Promise.resolve("cached-font"), delivered))
      .resolves.toBe("cached-font");
  });
});
