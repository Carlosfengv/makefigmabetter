import type { DocumentPaintStyleResource } from "../lib/editor-protocol";
import { runtimePaintsFromDocumentStack, type RuntimePaint } from "./runtime-paint";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";

export type RuntimePaintStyleHost = Readonly<{
  consumersForPaintStyle(styleId: string): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly string[] }>[];
  getPluginData(styleId: string, key: string): string;
  setPluginData(styleId: string, key: string, value: string): void;
  getPluginDataKeys(styleId: string): readonly string[];
  getSharedPluginData(styleId: string, namespace: string, key: string): string;
  setSharedPluginData(styleId: string, namespace: string, key: string, value: string): void;
  getSharedPluginDataKeys(styleId: string, namespace: string): readonly string[];
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
  getPluginData(key: string): string { return this.host.getPluginData(this.id, key); }
  setPluginData(key: string, value: string): void { this.host.setPluginData(this.id, key, value); }
  getPluginDataKeys(): readonly string[] { return this.host.getPluginDataKeys(this.id); }
  getSharedPluginData(namespace: string, key: string): string { return this.host.getSharedPluginData(this.id, namespace, key); }
  setSharedPluginData(namespace: string, key: string, value: string): void { this.host.setSharedPluginData(this.id, namespace, key, value); }
  getSharedPluginDataKeys(namespace: string): readonly string[] { return this.host.getSharedPluginDataKeys(this.id, namespace); }
  setBoundVariable(field: string, variable: unknown): never { void field; void variable; throw runtimeError("UNSUPPORTED_FEATURE"); }
}
