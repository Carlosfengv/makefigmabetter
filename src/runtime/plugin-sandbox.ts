import { runtimeError } from "./runtime-errors";

export const PLUGIN_PERMISSIONS = ["document:read", "document:write", "network", "widget:sync"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export type PluginLifecycleState = "created" | "running" | "closed";
export type PluginRequestKind = "document.read" | "document.write" | "network.fetch" | "widget.sync";

export type PluginManifest = Readonly<{
  id: string;
  name: string;
  apiVersion: 1;
  permissions: readonly PluginPermission[];
  networkDomains?: readonly string[];
}>;

export type PluginRequest = Readonly<{
  requestId: string;
  kind: PluginRequestKind;
  payload?: unknown;
}>;
export type PluginSandboxMessage = Readonly<{
  channel: "makefigma.plugin.v1";
  pluginId: string;
  request: PluginRequest;
}>;

export type PluginSandboxHost = Readonly<{
  handle(request: PluginRequest, signal: AbortSignal): Promise<unknown>;
  onLifecycleChange?: (state: PluginLifecycleState) => void;
}>;

export type PluginSandboxOptions = Readonly<{
  timeoutMs?: number;
  maxPendingRequests?: number;
  maxRequestsPerWindow?: number;
  requestWindowMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxRememberedRequestIds?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}>;

export const DEFAULT_PLUGIN_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_PLUGIN_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_PLUGIN_REQUEST_WINDOW_MS = 60_000;
export const DEFAULT_PLUGIN_REQUESTS_PER_WINDOW = 120;
export const DEFAULT_PLUGIN_REMEMBERED_REQUEST_IDS = 1_024;

/** Validates a deliberately small manifest. It is configuration, never code:
 * no entrypoint or arbitrary URL is accepted at this boundary. */
export function validatePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("INVALID_ARGUMENT");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9.-]{2,127}$/u.test(candidate.id)) throw runtimeError("INVALID_ARGUMENT");
  if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 128 || candidate.apiVersion !== 1) throw runtimeError("INVALID_ARGUMENT");
  if (!Array.isArray(candidate.permissions) || new Set(candidate.permissions).size !== candidate.permissions.length || !candidate.permissions.every((permission): permission is PluginPermission => typeof permission === "string" && (PLUGIN_PERMISSIONS as readonly string[]).includes(permission))) throw runtimeError("INVALID_ARGUMENT");
  const networkDomains = candidate.networkDomains;
  if (networkDomains !== undefined && (!Array.isArray(networkDomains) || !candidate.permissions.includes("network") || networkDomains.length > 32 || !networkDomains.every(validNetworkDomain))) throw runtimeError("INVALID_ARGUMENT");
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    apiVersion: 1,
    permissions: [...candidate.permissions],
    ...(networkDomains ? { networkDomains: [...networkDomains] } : {}),
  };
}

/** CSP is generated only from a validated manifest and defaults to no network.
 * The iframe still has an opaque origin (`allow-scripts`, never same-origin). */
export function pluginSandboxContentSecurityPolicy(manifest: PluginManifest): string {
  const connect = manifest.permissions.includes("network") && manifest.networkDomains?.length
    ? manifest.networkDomains.map((domain) => `https://${domain}`).join(" ")
    : "'none'";
  return `default-src 'none'; base-uri 'none'; connect-src ${connect}; form-action 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'`;
}

export class PluginSandboxSession {
  private state: PluginLifecycleState = "created";
  private readonly timeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxRequestsPerWindow: number;
  private readonly requestWindowMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxRememberedRequestIds: number;
  private readonly setTimer: NonNullable<PluginSandboxOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<PluginSandboxOptions["clearTimer"]>;
  private readonly pending = new Map<string, AbortController>();
  private readonly completedRequestIds = new Set<string>();
  private readonly completedRequestOrder: string[] = [];
  private readonly requestTimes: number[] = [];
  private readonly now: NonNullable<PluginSandboxOptions["now"]>;

  constructor(readonly manifest: PluginManifest, private readonly host: PluginSandboxHost, options: PluginSandboxOptions = {}) {
    this.timeoutMs = finiteTimeout(options.timeoutMs ?? 5_000);
    this.maxPendingRequests = boundedPendingRequests(options.maxPendingRequests ?? 32);
    this.maxRequestsPerWindow = boundedRequestWindowCount(options.maxRequestsPerWindow ?? DEFAULT_PLUGIN_REQUESTS_PER_WINDOW);
    this.requestWindowMs = boundedRequestWindowMs(options.requestWindowMs ?? DEFAULT_PLUGIN_REQUEST_WINDOW_MS);
    this.maxRequestBytes = boundedMessageBytes(options.maxRequestBytes ?? DEFAULT_PLUGIN_REQUEST_BYTES);
    this.maxResponseBytes = boundedMessageBytes(options.maxResponseBytes ?? DEFAULT_PLUGIN_RESPONSE_BYTES);
    this.maxRememberedRequestIds = boundedRememberedRequestIds(options.maxRememberedRequestIds ?? DEFAULT_PLUGIN_REMEMBERED_REQUEST_IDS);
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.now = options.now ?? (() => Date.now());
  }

  get lifecycleState(): PluginLifecycleState { return this.state; }

  start(): void {
    if (this.state === "closed") throw runtimeError("RUNTIME_CLOSED");
    if (this.state === "running") return;
    this.state = "running";
    this.host.onLifecycleChange?.(this.state);
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.pending.forEach((controller) => controller.abort("closed"));
    this.pending.clear();
    this.host.onLifecycleChange?.(this.state);
  }

  async request(request: PluginRequest): Promise<unknown> {
    if (this.state !== "running") throw runtimeError(this.state === "closed" ? "RUNTIME_CLOSED" : "RESOURCE_UNAVAILABLE");
    validatePluginRequest(request);
    if (encodedJsonByteLength(request) > this.maxRequestBytes) throw runtimeError("RESOURCE_LIMIT");
    if (this.pending.has(request.requestId) || this.completedRequestIds.has(request.requestId)) throw runtimeError("INVALID_ARGUMENT");
    if (!permits(this.manifest, request)) throw runtimeError("PERMISSION_DENIED");
    if (this.pending.size >= this.maxPendingRequests) throw runtimeError("RESOURCE_LIMIT");
    this.admitRequestWindow();
    const controller = new AbortController();
    this.pending.set(request.requestId, controller);
    try {
      const result = await withTimeout(this.host.handle(structuredClone(request), controller.signal), controller, this.timeoutMs, this.setTimer, this.clearTimer);
      if (!isBoundedJson(result) || encodedJsonByteLength(result) > this.maxResponseBytes) throw runtimeError("RESOURCE_LIMIT");
      return result;
    } finally {
      this.pending.delete(request.requestId);
      this.rememberCompletedRequestId(request.requestId);
    }
  }

  /** Browser adapters call this only after verifying `event.source` is the
   * session's iframe.  This data-level check then prevents one opaque-origin
   * plugin from addressing another plugin's host session. */
  receiveMessage(message: unknown): Promise<unknown> {
    if (encodedJsonByteLength(message) > this.maxRequestBytes) return Promise.reject(runtimeError("RESOURCE_LIMIT"));
    if (!message || typeof message !== "object" || Array.isArray(message)) return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    const envelope = message as Partial<PluginSandboxMessage>;
    if (envelope.channel !== "makefigma.plugin.v1" || envelope.pluginId !== this.manifest.id) return Promise.reject(runtimeError("PERMISSION_DENIED"));
    if (!envelope.request) return Promise.reject(runtimeError("INVALID_ARGUMENT"));
    return this.request(envelope.request);
  }

  /** Bridge adapters must account for their protocol envelope too, not only
   * the Host result nested inside it. */
  assertOutboundMessageBytes(message: unknown): void {
    if (encodedJsonByteLength(message) > this.maxResponseBytes) throw runtimeError("RESOURCE_LIMIT");
  }

  private admitRequestWindow(): void {
    const now = this.now();
    if (!Number.isFinite(now)) throw runtimeError("RESOURCE_LIMIT");
    while (this.requestTimes[0] !== undefined && now - this.requestTimes[0]! >= this.requestWindowMs) this.requestTimes.shift();
    if (this.requestTimes.length >= this.maxRequestsPerWindow) throw runtimeError("RESOURCE_LIMIT");
    this.requestTimes.push(now);
  }

  /** A request ID is a single-use capability within one plugin session. The
   * bounded ledger prevents post-settlement replay of document mutations while
   * keeping untrusted IDs from accumulating for the lifetime of the page. */
  private rememberCompletedRequestId(requestId: string): void {
    this.completedRequestIds.add(requestId);
    this.completedRequestOrder.push(requestId);
    while (this.completedRequestOrder.length > this.maxRememberedRequestIds) {
      const expired = this.completedRequestOrder.shift();
      if (expired) this.completedRequestIds.delete(expired);
    }
  }
}

function permits(manifest: PluginManifest, request: PluginRequest): boolean {
  const permission: PluginPermission = request.kind === "document.read" ? "document:read"
    : request.kind === "document.write" ? "document:write"
      : request.kind === "widget.sync" ? "widget:sync" : "network";
  if (!manifest.permissions.includes(permission)) return false;
  if (request.kind !== "network.fetch") return true;
  const url = payloadUrl(request.payload);
  return Boolean(url && manifest.networkDomains?.some((domain) => url.hostname === domain));
}

function validatePluginRequest(value: unknown): asserts value is PluginRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("INVALID_ARGUMENT");
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(request.requestId) || !["document.read", "document.write", "network.fetch", "widget.sync"].includes(String(request.kind)) || !isBoundedJson(request.payload)) throw runtimeError("INVALID_ARGUMENT");
  if (request.kind === "network.fetch" && !payloadUrl(request.payload)) throw runtimeError("INVALID_ARGUMENT");
}

function payloadUrl(payload: unknown): URL | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as Record<string, unknown>).url !== "string") return undefined;
  try {
    const url = new URL((payload as Record<string, string>).url);
    return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

function validNetworkDomain(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value);
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return typeof value !== "string" || value.length <= 16_384;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8 || Array.isArray(value)) return Array.isArray(value) && value.length <= 128 && value.every((entry) => isBoundedJson(entry, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, entry]) => key.length <= 128 && isBoundedJson(entry, depth + 1));
}

function finiteTimeout(value: number) { return Number.isFinite(value) && value >= 1 && value <= 60_000 ? value : 5_000; }
function boundedPendingRequests(value: number) { return Number.isSafeInteger(value) && value >= 1 && value <= 128 ? value : 32; }
function boundedRequestWindowCount(value: number) { return Number.isSafeInteger(value) && value >= 1 && value <= 1_024 ? value : DEFAULT_PLUGIN_REQUESTS_PER_WINDOW; }
function boundedRequestWindowMs(value: number) { return Number.isSafeInteger(value) && value >= 1_000 && value <= 60_000 ? value : DEFAULT_PLUGIN_REQUEST_WINDOW_MS; }
function boundedMessageBytes(value: number) { return Number.isSafeInteger(value) && value >= 1_024 && value <= 512 * 1024 ? value : DEFAULT_PLUGIN_REQUEST_BYTES; }
function boundedRememberedRequestIds(value: number) { return Number.isSafeInteger(value) && value >= 1 && value <= 4_096 ? value : DEFAULT_PLUGIN_REMEMBERED_REQUEST_IDS; }
function encodedJsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
  } catch { return Infinity; }
}

function withTimeout<T>(promise: Promise<T>, controller: AbortController, timeoutMs: number, setTimer: NonNullable<PluginSandboxOptions["setTimer"]>, clearTimer: NonNullable<PluginSandboxOptions["clearTimer"]>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const state: { timer?: ReturnType<typeof setTimeout> } = {};
    const cleanup = () => {
      controller.signal.removeEventListener("abort", onAbort);
      if (state.timer !== undefined) clearTimer(state.timer);
    };
    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => settleReject(runtimeError(controller.signal.reason === "closed" ? "RUNTIME_CLOSED" : "TIMEOUT"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    state.timer = setTimer(() => controller.abort("timeout"), timeoutMs);
    promise.then(settleResolve, settleReject);
  });
}
