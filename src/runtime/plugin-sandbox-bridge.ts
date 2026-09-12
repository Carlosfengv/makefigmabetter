import { isRuntimeError } from "./runtime-errors";
import { PluginSandboxSession, type PluginSandboxMessage } from "./plugin-sandbox";

export type PluginMessageEvent = Readonly<{ source: unknown; data: unknown }>;
export type PluginMessageTarget = Readonly<{ postMessage(message: unknown, targetOrigin: string): void }>;
export type PluginSandboxResponse = Readonly<{
  channel: "makefigma.plugin.v1";
  pluginId: string;
  requestId: string;
  ok: boolean;
  result?: JsonSafe;
  errorCode?: string;
}>;
type JsonSafe = null | boolean | number | string | readonly JsonSafe[] | { readonly [key: string]: JsonSafe };

/** Browser-facing boundary for an opaque-origin iframe. `targetOrigin` must be
 * `*` because opaque origins serialize as `null`; identity is instead bound to
 * the iframe Window object before any plugin message is parsed. */
export class PluginSandboxBridge {
  constructor(private readonly session: PluginSandboxSession, private readonly pluginWindow: PluginMessageTarget) {}

  async handleMessage(event: PluginMessageEvent): Promise<boolean> {
    if (event.source !== this.pluginWindow) return false;
    const requestId = messageRequestId(event.data);
    try {
      const result = await this.session.receiveMessage(event.data);
      const response = { channel: "makefigma.plugin.v1", pluginId: this.session.manifest.id, requestId, ok: true, ...(isJsonSafe(result) ? { result: structuredClone(result) } : {}) } satisfies PluginSandboxResponse;
      this.session.assertOutboundMessageBytes(response);
      this.pluginWindow.postMessage(response, "*");
    } catch (error) {
      this.pluginWindow.postMessage({ channel: "makefigma.plugin.v1", pluginId: this.session.manifest.id, requestId, ok: false, errorCode: isRuntimeError(error) ? error.code : "INTERNAL_ERROR" } satisfies PluginSandboxResponse, "*");
    }
    return true;
  }
}

function messageRequestId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const request = (value as Partial<PluginSandboxMessage>).request;
  return request && typeof request.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(request.requestId) ? request.requestId : "invalid";
}
function isJsonSafe(value: unknown, depth = 0): value is JsonSafe { return value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (depth < 8 && Array.isArray(value) && value.length <= 128 && value.every((item) => isJsonSafe(item, depth + 1))) || (depth < 8 && Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length <= 128 && Object.values(value).every((item) => isJsonSafe(item, depth + 1)))); }
