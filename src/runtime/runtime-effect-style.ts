import type { DocumentEffectStyleResource } from "../lib/editor-protocol";
import { documentEffectsFromRuntime, runtimeEffectsFromDocument, type RuntimeEffect } from "./runtime-effect";
import { runtimeError } from "./runtime-errors";
import { runtimeStyleDocumentationLinks } from "./runtime-style-metadata";

export type RuntimeEffectStyleHost = Readonly<{
  effectStyleResource(styleId: string): DocumentEffectStyleResource | undefined;
  setEffectStyle(style: DocumentEffectStyleResource): void;
  deleteEffectStyle(styleId: string): void;
  getPluginData(styleId: string, key: string): string;
  setPluginData(styleId: string, key: string, value: string): void;
  getPluginDataKeys(styleId: string): readonly string[];
  getSharedPluginData(styleId: string, namespace: string, key: string): string;
  setSharedPluginData(styleId: string, namespace: string, key: string, value: string): void;
  getSharedPluginDataKeys(styleId: string, namespace: string): readonly string[];
}>;

/** Live projection of one canonical EffectStyle resource. */
export class RuntimeEffectStyle {
  readonly type = "EFFECT" as const;
  private readonly styleId: string;

  constructor(resource: DocumentEffectStyleResource, private readonly host: RuntimeEffectStyleHost) {
    this.styleId = resource.id;
  }

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
  get descriptionMarkdown(): string { return this.current().descriptionMarkdown; }
  set descriptionMarkdown(value: string) {
    if (typeof value !== "string" || value.includes("\0")) throw runtimeError("INVALID_ARGUMENT");
    this.write({ descriptionMarkdown: value });
  }
  get documentationLinks(): readonly { readonly uri: string }[] {
    return Object.freeze(this.current().documentationLinks.map((link) => Object.freeze({ ...link })));
  }
  set documentationLinks(value: readonly { readonly uri: string }[]) {
    this.write({ documentationLinks: runtimeStyleDocumentationLinks(value) });
  }
  get effects(): readonly RuntimeEffect[] { return Object.freeze(runtimeEffectsFromDocument(this.current().effects)); }
  set effects(value: readonly RuntimeEffect[]) { this.write({ effects: documentEffectsFromRuntime(value) }); }
  get boundVariables(): undefined { return undefined; }
  get consumers(): readonly never[] { return Object.freeze([]); }
  async getStyleConsumersAsync(): Promise<readonly never[]> { await Promise.resolve(); return Object.freeze([]); }
  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> { await Promise.resolve(); return this.current().key ? "CURRENT" : "UNPUBLISHED"; }
  remove(): void {
    if (this.current().remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.deleteEffectStyle(this.id);
  }
  getPluginData(key: string): string { return this.host.getPluginData(this.id, key); }
  setPluginData(key: string, value: string): void { this.host.setPluginData(this.id, key, value); }
  getPluginDataKeys(): readonly string[] { return this.host.getPluginDataKeys(this.id); }
  getSharedPluginData(namespace: string, key: string): string { return this.host.getSharedPluginData(this.id, namespace, key); }
  setSharedPluginData(namespace: string, key: string, value: string): void { this.host.setSharedPluginData(this.id, namespace, key, value); }
  getSharedPluginDataKeys(namespace: string): readonly string[] { return this.host.getSharedPluginDataKeys(this.id, namespace); }
  setBoundVariable(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }

  private current(): DocumentEffectStyleResource {
    const resource = this.host.effectStyleResource(this.styleId);
    if (!resource) throw runtimeError("RESOURCE_UNAVAILABLE");
    return resource;
  }
  private write(patch: Partial<DocumentEffectStyleResource>): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.setEffectStyle({ ...structuredClone(resource), ...patch });
  }
}
