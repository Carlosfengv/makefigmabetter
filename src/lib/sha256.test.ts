import { describe, expect, it } from "vitest";
import { sha256Fallback, sha256Hex } from "./sha256";

const encoder = new TextEncoder();
const asHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("sha256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["Makefigma LAN", "4b1f654074b7d8c93e8abb1aaf7c69d529ed337b9b4d4e39f0b0d4ae7f1b1562"],
  ])("uses the standards-compliant fallback for %j", (input, expected) => {
    expect(asHex(sha256Fallback(encoder.encode(input)))).toBe(expected);
  });

  it("uses the same bytes through the public API", async () => {
    await expect(sha256Hex(encoder.encode("abc"))).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
