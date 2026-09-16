import type { DocumentPaintStyleResource } from "../lib/editor-protocol";
import { runtimePaintsFromDocumentStack, type RuntimePaint } from "./runtime-paint";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";

export type RuntimePaintStyleHost = Readonly<{
  consumersForPaintStyle(styleId: string): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly string[] }>[];
}>;

/** Read projection of one canonical PaintStyle resource. */
export class RuntimePaintStyle {
  readonly type = "PAINT" as const;

  constructor(
    private readonly resource: DocumentPaintStyleResource,
    private readonly host: RuntimePaintStyleHost,
  ) {}

  get id(): string { return this.resource.id; }
  get key(): string { return this.resource.key; }
  get remote(): boolean { return this.resource.remote; }
  get name(): string { return this.resource.name; }
  set name(_value: string) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get description(): string { return this.resource.description; }
  set description(_value: string) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get descriptionMarkdown(): string { return this.resource.description; }
  set descriptionMarkdown(_value: string) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get documentationLinks(): readonly { readonly uri: string }[] { return Object.freeze([]); }
  set documentationLinks(_value: readonly { readonly uri: string }[]) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get paints(): readonly RuntimePaint[] { return Object.freeze([...runtimePaintsFromDocumentStack(this.resource.paints)]); }
  set paints(_value: readonly RuntimePaint[]) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get boundVariables(): undefined { return undefined; }

  get consumers(): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly string[] }>[] {
    return this.host.consumersForPaintStyle(this.id);
  }

  async getStyleConsumersAsync(): Promise<readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly string[] }>[]> {
    await Promise.resolve();
    return this.host.consumersForPaintStyle(this.id);
  }

  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> {
    await Promise.resolve();
    return this.resource.key ? "CURRENT" : "UNPUBLISHED";
  }

  remove(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginData(key: string): string { void key; return ""; }
  setPluginData(key: string, value: string): never { void key; void value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginDataKeys(): string[] { return []; }
  getSharedPluginData(namespace: string, key: string): string { void namespace; void key; return ""; }
  setSharedPluginData(namespace: string, key: string, value: string): never { void namespace; void key; void value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getSharedPluginDataKeys(namespace: string): string[] { void namespace; return []; }
  setBoundVariable(field: string, variable: unknown): never { void field; void variable; throw runtimeError("UNSUPPORTED_FEATURE"); }
}
