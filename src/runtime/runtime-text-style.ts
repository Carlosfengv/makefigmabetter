import type { DocumentTextStyleResource } from "../lib/editor-protocol";
import type { RuntimeFontName } from "./runtime-font-name";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";

export type RuntimeTextStyleHost = Readonly<{
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
    private readonly resource: DocumentTextStyleResource,
    private readonly host: RuntimeTextStyleHost,
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

  get fontSize(): number { return this.resource.style.fontSize; }
  set fontSize(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get fontName(): RuntimeFontName { return this.host.fontNameForStyle(this.resource); }
  set fontName(_value: RuntimeFontName) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get textDecoration(): "NONE" | "UNDERLINE" | "STRIKETHROUGH" {
    return (this.resource.style.textDecoration?.toUpperCase() as "UNDERLINE" | "STRIKETHROUGH" | undefined) ?? "NONE";
  }
  set textDecoration(_value: "NONE" | "UNDERLINE" | "STRIKETHROUGH") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get letterSpacing(): Readonly<{ value: number; unit: "PIXELS" }> {
    return Object.freeze({ value: this.resource.style.letterSpacing, unit: "PIXELS" });
  }
  set letterSpacing(_value: Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get lineHeight(): Readonly<{ unit: "AUTO" } | { value: number; unit: "PIXELS" | "PERCENT" }> {
    if (this.resource.paragraph.lineHeightUnit === "auto") return Object.freeze({ unit: "AUTO" });
    return Object.freeze({
      value: this.resource.paragraph.lineHeight ?? 20,
      unit: this.resource.paragraph.lineHeightUnit === "percent" ? "PERCENT" : "PIXELS",
    });
  }
  set lineHeight(_value: Readonly<{ unit: "AUTO" } | { value: number; unit: "PIXELS" | "PERCENT" }>) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get leadingTrim(): "CAP_HEIGHT" | "NONE" { return this.resource.style.leadingTrim === "capHeight" ? "CAP_HEIGHT" : "NONE"; }
  set leadingTrim(_value: "CAP_HEIGHT" | "NONE") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get paragraphIndent(): number { return this.resource.paragraph.paragraphIndent ?? 0; }
  set paragraphIndent(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get paragraphSpacing(): number { return this.resource.paragraph.paragraphSpacing; }
  set paragraphSpacing(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get textWrapStyle(): "AUTO" | "BALANCE" | "PRETTY" {
    return (this.resource.paragraph.textWrapStyle?.toUpperCase() as "BALANCE" | "PRETTY" | undefined) ?? "AUTO";
  }
  set textWrapStyle(_value: "AUTO" | "BALANCE" | "PRETTY") { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get listSpacing(): number { return this.resource.paragraph.listSpacing ?? 0; }
  set listSpacing(_value: number) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get hangingPunctuation(): boolean { return this.resource.paragraph.hangingPunctuation ?? false; }
  set hangingPunctuation(_value: boolean) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get hangingList(): boolean { return this.resource.paragraph.hangingList ?? false; }
  set hangingList(_value: boolean) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get textCase(): "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED" {
    const value = this.resource.style.textCase;
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

  private consumerRecords(): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly ["textStyleId"] }>[] {
    return Object.freeze(this.host.consumersForTextStyle(this.id).map((node) => Object.freeze({
      node,
      fields: Object.freeze(["textStyleId"] as const),
    })));
  }
}
