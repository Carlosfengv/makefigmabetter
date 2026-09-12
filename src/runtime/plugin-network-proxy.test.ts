import { describe, expect, it } from "vitest";
import { isRuntimeError } from "./runtime-errors";
import { isLiteralPrivateAddress, PluginNetworkProxy } from "./plugin-network-proxy";
import { validatePluginManifest } from "./plugin-sandbox";

const manifest = validatePluginManifest({ id: "com.example.network", name: "Network", apiVersion: 1, permissions: ["network"], networkDomains: ["api.example.com", "cdn.example.com"] });
const publicDns = { resolve: async () => ["203.0.113.10"], fetch: async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }) };

describe("M7 plugin network proxy", () => {
  it("checks the exact host, DNS answer and response limits before returning bytes", async () => {
    const response = await new PluginNetworkProxy(publicDns).fetch(manifest, "https://api.example.com/v1", new AbortController().signal);
    expect(new TextDecoder().decode(response.bytes)).toBe('{"ok":true}');
    await expect(new PluginNetworkProxy(publicDns).fetch(manifest, "https://api.example.com:8443/v1", new AbortController().signal)).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "URL_NOT_ALLOWED"));
    await expect(new PluginNetworkProxy({ ...publicDns, resolve: async () => ["127.0.0.1"] }).fetch(manifest, "https://api.example.com/v1", new AbortController().signal)).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "URL_NOT_ALLOWED"));
  });

  it("rechecks every redirect and rejects oversized or disallowed content", async () => {
    const redirecting = new PluginNetworkProxy({ resolve: async () => ["203.0.113.10"], fetch: async (url) => url.includes("api.example.com")
      ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/poster" } })
      : new Response(new Uint8Array(32), { status: 200, headers: { "content-type": "image/png" } }) });
    await expect(redirecting.fetch(manifest, "https://api.example.com/start", new AbortController().signal)).resolves.toMatchObject({ url: "https://cdn.example.com/poster" });
    const oversize = new PluginNetworkProxy({ ...publicDns, fetch: async () => new Response(new Uint8Array(9), { status: 200, headers: { "content-type": "text/plain", "content-length": "9" } }) }, { maxBytes: 8 });
    await expect(oversize.fetch(manifest, "https://api.example.com/large", new AbortController().signal)).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));
    const privateRedirect = new PluginNetworkProxy({ ...publicDns, fetch: async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/" } }) });
    await expect(privateRedirect.fetch(manifest, "https://api.example.com/start", new AbortController().signal)).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "URL_NOT_ALLOWED"));
  });

  it("stops reading a chunked response as soon as it exceeds the byte budget", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    });
    const proxy = new PluginNetworkProxy({
      ...publicDns,
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    }, { maxBytes: 8 });
    await expect(proxy.fetch(manifest, "https://api.example.com/chunked", new AbortController().signal)).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));
    expect(cancelled).toBe(true);
  });

  it("rejects IPv4-mapped private IPv6 without mistaking hostnames for addresses", () => {
    expect(isLiteralPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLiteralPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isLiteralPrivateAddress("999.1.1.1")).toBe(true);
    expect(isLiteralPrivateAddress("fc.example.com")).toBe(false);
    expect(isLiteralPrivateAddress("fd.example.com")).toBe(false);
  });
});
