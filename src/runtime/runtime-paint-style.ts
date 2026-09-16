import type { DocumentPaintStyleResource } from "../lib/editor-protocol";
import { runtimePaintsFromDocumentStack, type RuntimePaint } from "./runtime-paint";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";

export type RuntimePaintStyleHost = Readonly<{
  paintStyleResource(styleId: string): DocumentPaintStyleResource | undefined;
  setPaintStyle(style: DocumentPaintStyleResource): void;
  deletePaintStyle(styleId: string): void;
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
    resource: DocumentPaintStyleResource,
    private readonly host: RuntimePaintStyleHost,
  ) { this.styleId = resource.id; }

  private readonly styleId: string;

  get id(): string { return this.styleId; }
  get key(): string { return this.current().key; }
  get remote(): boolean { return this.current().remote; }
  get name(): string { return this.current().name; }
  set name(value: string) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw runtimeError("INVALID_ARGUMENT");
    this.write({ name: value });
  }
  get description(): string { return this.current().description; }
  set description(value: string) {
    if (typeof value !== "string" || value.includes("\0")) throw runtimeError("INVALID_ARGUMENT");
    this.write({ description: value });
  }
  get descriptionMarkdown(): string { return this.current().description; }
  set descriptionMarkdown(value: string) { this.description = value; }
  get documentationLinks(): readonly { readonly uri: string }[] { return Object.freeze([]); }
  set documentationLinks(_value: readonly { readonly uri: string }[]) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get paints(): readonly RuntimePaint[] { return Object.freeze([...runtimePaintsFromDocumentStack(this.current().paints)]); }
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
    return this.current().key ? "CURRENT" : "UNPUBLISHED";
  }

  remove(): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.deletePaintStyle(this.id);
  }
  getPluginData(key: string): string { return this.host.getPluginData(this.id, key); }
  setPluginData(key: string, value: string): void { this.host.setPluginData(this.id, key, value); }
  getPluginDataKeys(): readonly string[] { return this.host.getPluginDataKeys(this.id); }
  getSharedPluginData(namespace: string, key: string): string { return this.host.getSharedPluginData(this.id, namespace, key); }
  setSharedPluginData(namespace: string, key: string, value: string): void { this.host.setSharedPluginData(this.id, namespace, key, value); }
  getSharedPluginDataKeys(namespace: string): readonly string[] { return this.host.getSharedPluginDataKeys(this.id, namespace); }
  setBoundVariable(field: string, variable: unknown): never { void field; void variable; throw runtimeError("UNSUPPORTED_FEATURE"); }

  private current(): DocumentPaintStyleResource {
    const resource = this.host.paintStyleResource(this.styleId);
    if (!resource) throw runtimeError("RESOURCE_UNAVAILABLE");
    return resource;
  }

  private write(patch: Pick<Partial<DocumentPaintStyleResource>, "name" | "description">): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.setPaintStyle({ ...structuredClone(resource), ...patch });
  }
}
