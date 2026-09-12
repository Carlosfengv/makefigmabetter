import { isRuntimeError, runtimeError } from "./runtime-errors";
import type { PluginManifest } from "./plugin-sandbox";

export type PluginNetworkTransport = Readonly<{
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  fetch(url: string, init: Readonly<{ method: "GET"; redirect: "manual"; signal: AbortSignal }>): Promise<Response>;
}>;
export type PluginNetworkResponse = Readonly<{ url: string; contentType: string; bytes: Uint8Array }>;
export type PluginNetworkProxyOptions = Readonly<{ maxRedirects?: number; maxBytes?: number; allowedContentTypes?: readonly string[] }>;

/**
 * The only network primitive intended for plugin hosts. Every redirect repeats
 * manifest host and DNS-address checks; opaque iframe CSP is defense in depth,
 * not the authorization mechanism. The transport owns DNS and HTTP so a host
 * can enforce its own egress policy without exposing `fetch` to plugin code.
 */
export class PluginNetworkProxy {
  private readonly maxRedirects: number;
  private readonly maxBytes: number;
  private readonly allowedContentTypes: Set<string>;

  constructor(private readonly transport: PluginNetworkTransport, options: PluginNetworkProxyOptions = {}) {
    this.maxRedirects = boundedInteger(options.maxRedirects ?? 3, 0, 8);
    this.maxBytes = boundedInteger(options.maxBytes ?? 1_048_576, 1, 8 * 1_048_576);
    this.allowedContentTypes = new Set(options.allowedContentTypes ?? ["application/json", "text/plain", "image/png", "image/jpeg", "image/webp"]);
  }

  async fetch(manifest: PluginManifest, requestedUrl: string, signal: AbortSignal): Promise<PluginNetworkResponse> {
    if (!manifest.permissions.includes("network")) throw runtimeError("PERMISSION_DENIED");
    let current = safeNetworkUrl(requestedUrl, manifest);
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      await this.assertPublicResolution(current, signal);
      let response: Response;
      try { response = await this.transport.fetch(current.toString(), { method: "GET", redirect: "manual", signal }); }
      catch { throw runtimeError("RESOURCE_UNAVAILABLE"); }
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === this.maxRedirects) throw runtimeError("URL_NOT_ALLOWED");
        current = safeNetworkUrl(new URL(location, current).toString(), manifest);
        continue;
      }
      if (!response.ok) throw runtimeError("RESOURCE_UNAVAILABLE");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!this.allowedContentTypes.has(contentType)) throw runtimeError("RESOURCE_UNAVAILABLE");
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) throw runtimeError("RESOURCE_LIMIT");
      const bytes = await readBoundedResponseBody(response, this.maxBytes);
      return { url: current.toString(), contentType, bytes };
    }
    throw runtimeError("URL_NOT_ALLOWED");
  }

  private async assertPublicResolution(url: URL, signal: AbortSignal): Promise<void> {
    if (isLiteralPrivateAddress(url.hostname)) throw runtimeError("URL_NOT_ALLOWED");
    let addresses: readonly string[];
    try { addresses = await this.transport.resolve(url.hostname, signal); }
    catch { throw runtimeError("RESOURCE_UNAVAILABLE"); }
    if (!addresses.length || addresses.some(isLiteralPrivateAddress)) throw runtimeError("URL_NOT_ALLOWED");
  }
}

function safeNetworkUrl(value: string, manifest: PluginManifest): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw runtimeError("URL_NOT_ALLOWED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.toString().length > 4_096 || !manifest.networkDomains?.includes(url.hostname)) throw runtimeError("URL_NOT_ALLOWED");
  return url;
}
function isRedirect(status: number) { return status === 301 || status === 302 || status === 303 || status === 307 || status === 308; }
function boundedInteger(value: number, minimum: number, maximum: number) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : minimum; }

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw runtimeError("RESOURCE_LIMIT");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (isRuntimeError(error)) throw error;
    throw runtimeError("RESOURCE_UNAVAILABLE");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reject literal loopback, link-local, RFC1918, carrier-grade NAT, multicast
 * and IPv6 local/unspecified/mapped forms before any outbound connection. */
export function isLiteralPrivateAddress(value: string): boolean {
  const host = value.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost") return true;
  const octets = ipv4Octets(host);
  if (octets) return privateIpv4(octets);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return true;
  const words = ipv6Words(host);
  if (!words) return false;
  const first = words[0]!;
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) return true;
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
    || words.slice(0, 6).every((word) => word === 0);
  return mappedIpv4 && privateIpv4([
    words[6]! >> 8,
    words[6]! & 0xff,
    words[7]! >> 8,
    words[7]! & 0xff,
  ]);
}

function ipv4Octets(value: string): number[] | undefined {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.some((octet) => octet > 255) ? undefined : octets;
}

function privateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function ipv6Words(value: string): number[] | undefined {
  if (!value.includes(":")) return undefined;
  let normalized = value;
  const dottedSuffix = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (dottedSuffix) {
    const octets = ipv4Octets(dottedSuffix);
    if (!octets) return undefined;
    normalized = `${normalized.slice(0, -dottedSuffix.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (![...left, ...right].every((part) => /^[0-9a-f]{1,4}$/u.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  return [...left.map((part) => Number.parseInt(part, 16)), ...Array.from({ length: missing }, () => 0), ...right.map((part) => Number.parseInt(part, 16))];
}
