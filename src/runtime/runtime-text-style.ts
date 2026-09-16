import type { DocumentTextStyleResource } from "../lib/editor-protocol";
import type { RuntimeFontName } from "./runtime-font-name";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";

export type RuntimeTextStyleHost = Readonly<{
  textStyleResource(styleId: string): DocumentTextStyleResource | undefined;
  setTextStyle(style: DocumentTextStyleResource): void;
  deleteTextStyle(styleId: string): void;
  fontNameForStyle(style: DocumentTextStyleResource): RuntimeFontName;
  consumersForTextStyle(styleId: string): readonly RuntimeNodeProxy[];
  getPluginData(styleId: string, key: string): string;
  setPluginData(styleId: string, key: string, value: string): void;
  getPluginDataKeys(styleId: string): readonly string[];
  getSharedPluginData(styleId: string, namespace: string, key: string): string;
  setSharedPluginData(styleId: string, namespace: string, key: string, value: string): void;
  getSharedPluginDataKeys(styleId: string, namespace: string): readonly string[];
}>;

/** Read projection of one canonical TextStyle resource. Resource mutation is
 * introduced separately so this object never pretends a local write succeeded. */
export class RuntimeTextStyle {
  readonly type = "TEXT" as const;

  constructor(
    resource: DocumentTextStyleResource,
    private readonly host: RuntimeTextStyleHost,
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

  get fontSize(): number { return this.current().style.fontSize; }
  set fontSize(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get fontName(): RuntimeFontName { return this.host.fontNameForStyle(this.current()); }
  set fontName(_value: RuntimeFontName) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get textDecoration(): "NONE" | "UNDERLINE" | "STRIKETHROUGH" {
    return (this.current().style.textDecoration?.toUpperCase() as "UNDERLINE" | "STRIKETHROUGH" | undefined) ?? "NONE";
  }
  set textDecoration(_value: "NONE" | "UNDERLINE" | "STRIKETHROUGH") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get letterSpacing(): Readonly<{ value: number; unit: "PIXELS" }> {
    return Object.freeze({ value: this.current().style.letterSpacing, unit: "PIXELS" });
  }
  set letterSpacing(_value: Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get lineHeight(): Readonly<{ unit: "AUTO" } | { value: number; unit: "PIXELS" | "PERCENT" }> {
    const resource = this.current();
    if (resource.paragraph.lineHeightUnit === "auto") return Object.freeze({ unit: "AUTO" });
    return Object.freeze({
      value: resource.paragraph.lineHeight ?? 20,
      unit: resource.paragraph.lineHeightUnit === "percent" ? "PERCENT" : "PIXELS",
    });
  }
  set lineHeight(_value: Readonly<{ unit: "AUTO" } | { value: number; unit: "PIXELS" | "PERCENT" }>) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get leadingTrim(): "CAP_HEIGHT" | "NONE" { return this.current().style.leadingTrim === "capHeight" ? "CAP_HEIGHT" : "NONE"; }
  set leadingTrim(_value: "CAP_HEIGHT" | "NONE") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get paragraphIndent(): number { return this.current().paragraph.paragraphIndent ?? 0; }
  set paragraphIndent(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get paragraphSpacing(): number { return this.current().paragraph.paragraphSpacing; }
  set paragraphSpacing(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get textWrapStyle(): "AUTO" | "BALANCE" | "PRETTY" {
    return (this.current().paragraph.textWrapStyle?.toUpperCase() as "BALANCE" | "PRETTY" | undefined) ?? "AUTO";
  }
  set textWrapStyle(_value: "AUTO" | "BALANCE" | "PRETTY") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get listSpacing(): number { return this.current().paragraph.listSpacing ?? 0; }
  set listSpacing(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get hangingPunctuation(): boolean { return this.current().paragraph.hangingPunctuation ?? false; }
  set hangingPunctuation(_value: boolean) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get hangingList(): boolean { return this.current().paragraph.hangingList ?? false; }
  set hangingList(_value: boolean) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get textCase(): "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED" {
    const value = this.current().style.textCase;
    if (!value) return "ORIGINAL";
    if (value === "smallCaps") return "SMALL_CAPS";
    if (value === "smallCapsForced") return "SMALL_CAPS_FORCED";
    return value.toUpperCase() as "UPPER" | "LOWER" | "TITLE";
  }
  set textCase(_value: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get boundVariables(): undefined { return undefined; }

  get consumers(): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly ["textStyleId"] }>[] {
    return this.consumerRecords();
  }

  async getStyleConsumersAsync(): Promise<readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly ["textStyleId"] }>[]> {
    await Promise.resolve();
    return this.consumerRecords();
  }

  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> {
    await Promise.resolve();
    return this.current().key ? "CURRENT" : "UNPUBLISHED";
  }

  remove(): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.deleteTextStyle(this.id);
  }
  getPluginData(key: string): string { return this.host.getPluginData(this.id, key); }
  setPluginData(key: string, value: string): void { this.host.setPluginData(this.id, key, value); }
  getPluginDataKeys(): readonly string[] { return this.host.getPluginDataKeys(this.id); }
  getSharedPluginData(namespace: string, key: string): string { return this.host.getSharedPluginData(this.id, namespace, key); }
  setSharedPluginData(namespace: string, key: string, value: string): void { this.host.setSharedPluginData(this.id, namespace, key, value); }
  getSharedPluginDataKeys(namespace: string): readonly string[] { return this.host.getSharedPluginDataKeys(this.id, namespace); }
  setBoundVariable(field: string, variable: unknown): never { void field; void variable; throw runtimeError("UNSUPPORTED_FEATURE"); }

  private consumerRecords(): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly ["textStyleId"] }>[] {
    return Object.freeze(this.host.consumersForTextStyle(this.id).map((node) => Object.freeze({
      node,
      fields: Object.freeze(["textStyleId"] as const),
    })));
  }

  private current(): DocumentTextStyleResource {
    const resource = this.host.textStyleResource(this.styleId);
    if (!resource) throw runtimeError("RESOURCE_UNAVAILABLE");
    return resource;
  }

  private write(patch: Pick<Partial<DocumentTextStyleResource>, "name" | "description">): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.setTextStyle({ ...structuredClone(resource), ...patch });
  }
}
