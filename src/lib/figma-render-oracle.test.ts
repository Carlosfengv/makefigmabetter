import { describe, expect, it } from "vitest";
import { FigmaRenderOracleError, figmaRenderOracleEndpoint, requestFigmaRenderOracle } from "./figma-render-oracle";

describe("Figma Render Oracle", () => {
  it("normalizes an independently reproducible images request without exposing its token", async () => {
    let endpoint = "";
    let token = "";
    const result = await requestFigmaRenderOracle({ fileKey: "file key", nodeIds: ["2:1", "1:2", "2:1"], accessToken: "secret", format: "svg", scale: 2 }, async (url, init) => {
      endpoint = url;
      token = init.headers["X-Figma-Token"]!;
      return { ok: true, status: 200, json: async () => ({ images: { "2:1": "https://images.example/2", "1:2": "https://images.example/1", ignored: "https://images.example/ignored" } }) };
    });

    expect(endpoint).toBe("https://api.figma.com/v1/images/file%20key?ids=1%3A2%2C2%3A1&format=svg&scale=2");
    expect(token).toBe("secret");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).toEqual({ request: { fileKey: "file key", nodeIds: ["1:2", "2:1"], format: "svg", scale: 2, endpoint }, images: { "1:2": "https://images.example/1", "2:1": "https://images.example/2" } });
  });

  it("rejects live API failures and malformed Oracle responses", async () => {
    await expect(requestFigmaRenderOracle({ fileKey: "key", nodeIds: ["1:2"], accessToken: "secret" }, async () => ({ ok: false, status: 403, json: async () => ({}) }))).rejects.toMatchObject({ code: "REQUEST_FAILED", status: 403 });
    await expect(requestFigmaRenderOracle({ fileKey: "key", nodeIds: ["1:2"], accessToken: "secret" }, async () => ({ ok: true, status: 200, json: async () => ({ images: { "1:2": "http://not-secure" } }) }))).rejects.toBeInstanceOf(FigmaRenderOracleError);
    expect(() => figmaRenderOracleEndpoint("", ["1:2"])).toThrow(FigmaRenderOracleError);
  });
});
