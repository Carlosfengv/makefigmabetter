import type { DocumentTextStyleResource } from "../lib/editor-protocol";
import type { RuntimeFontName } from "./runtime-font-name";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";
import { runtimeStyleDocumentationLinks } from "./runtime-style-metadata";

export type RuntimeTextStyleHost = Readonly<{
  textStyleResource(styleId: string): DocumentTextStyleResource | undefined;
  setTextStyle(style: DocumentTextStyleResource): void;
  deleteTextStyle(styleId: string): void;
  fontNameForStyle(style: DocumentTextStyleResource): RuntimeFontName;
  resolveFontName(fontName: RuntimeFontName): DocumentTextStyleResource["style"]["font"];
  consumersForTextStyle(styleId: string): readonly RuntimeNodeProxy[];
  getPluginData(styleId: string, key: string): string;
  setPluginData(styleId: string, key: string, value: string): void;
  getPluginDataKeys(styleId: string): readonly string[];
  getSharedPluginData(styleId: string, namespace: string, key: string): string;
  setSharedPluginData(styleId: string, namespace: string, key: string, value: string): void;
  getSharedPluginDataKeys(styleId: string, namespace: string): readonly string[];
}>;

/** Live projection of one canonical TextStyle resource. */
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

  get fontSize(): number { return this.current().style.fontSize; }
  set fontSize(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw runtimeError("INVALID_ARGUMENT");
    this.writeStyle({ fontSize: value });
  }
  get fontName(): RuntimeFontName { return this.host.fontNameForStyle(this.current()); }
  set fontName(value: RuntimeFontName) { this.writeStyle({ font: this.host.resolveFontName(value) }); }
  get textDecoration(): "NONE" | "UNDERLINE" | "STRIKETHROUGH" {
    return (this.current().style.textDecoration?.toUpperCase() as "UNDERLINE" | "STRIKETHROUGH" | undefined) ?? "NONE";
  }
  set textDecoration(value: "NONE" | "UNDERLINE" | "STRIKETHROUGH") {
    if (value !== "NONE" && value !== "UNDERLINE" && value !== "STRIKETHROUGH") throw runtimeError("INVALID_ARGUMENT");
    this.writeStyle({ textDecoration: value === "NONE" ? undefined : value === "UNDERLINE" ? "underline" : "strikethrough" });
  }
  get letterSpacing(): Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }> {
    const resource = this.current();
    return Object.freeze({
      value: resource.style.letterSpacing,
      unit: resource.letterSpacingUnit === "percent" ? "PERCENT" : "PIXELS",
    });
  }
  set letterSpacing(value: Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>) {
    if (!value || (value.unit !== "PIXELS" && value.unit !== "PERCENT") || !Number.isFinite(value.value)
      || (value.unit === "PERCENT" && (value.value < -100 || value.value > 10_000))) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    const resource = this.current();
    this.write({
      style: { ...structuredClone(resource.style), letterSpacing: value.value },
      letterSpacingUnit: value.unit === "PERCENT" ? "percent" : undefined,
    });
  }
  get lineHeight(): Readonly<{ unit: "AUTO" } | { value: number; unit: "PIXELS" | "PERCENT" }> {
    const resource = this.current();
    if (resource.paragraph.lineHeightUnit === "auto") return Object.freeze({ unit: "AUTO" });
    return Object.freeze({
      value: resource.paragraph.lineHeight ?? 20,
      unit: resource.paragraph.lineHeightUnit === "percent" ? "PERCENT" : "PIXELS",
    });
  }
  set lineHeight(value: Readonly<{ unit: "AUTO" } | { value: number; unit: "PIXELS" | "PERCENT" }>) {
    if (!value || !["AUTO", "PIXELS", "PERCENT"].includes(value.unit)
      || (value.unit !== "AUTO" && (!Number.isFinite(value.value) || value.value <= 0))) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    this.writeParagraph(value.unit === "AUTO"
      ? { lineHeight: undefined, lineHeightUnit: "auto" }
      : { lineHeight: value.value, lineHeightUnit: value.unit === "PERCENT" ? "percent" : undefined });
  }
  get leadingTrim(): "CAP_HEIGHT" | "NONE" { return this.current().style.leadingTrim === "capHeight" ? "CAP_HEIGHT" : "NONE"; }
  set leadingTrim(value: "CAP_HEIGHT" | "NONE") {
    if (value !== "CAP_HEIGHT" && value !== "NONE") throw runtimeError("INVALID_ARGUMENT");
    this.writeStyle({ leadingTrim: value === "CAP_HEIGHT" ? "capHeight" : undefined });
  }
  get paragraphIndent(): number { return this.current().paragraph.paragraphIndent ?? 0; }
  set paragraphIndent(value: number) {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT");
    this.writeParagraph({ paragraphIndent: value || undefined });
  }
  get paragraphSpacing(): number { return this.current().paragraph.paragraphSpacing; }
  set paragraphSpacing(value: number) {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT");
    this.writeParagraph({ paragraphSpacing: value });
  }
  get textWrapStyle(): "AUTO" | "BALANCE" | "PRETTY" {
    return (this.current().paragraph.textWrapStyle?.toUpperCase() as "BALANCE" | "PRETTY" | undefined) ?? "AUTO";
  }
  set textWrapStyle(value: "AUTO" | "BALANCE" | "PRETTY") {
    if (value !== "AUTO" && value !== "BALANCE" && value !== "PRETTY") throw runtimeError("INVALID_ARGUMENT");
    this.writeParagraph({ textWrapStyle: value === "AUTO" ? undefined : value === "BALANCE" ? "balance" : "pretty" });
  }
  get listSpacing(): number { return this.current().paragraph.listSpacing ?? 0; }
  set listSpacing(value: number) {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT");
    this.writeParagraph({ listSpacing: value || undefined });
  }
  get hangingPunctuation(): boolean { return this.current().paragraph.hangingPunctuation ?? false; }
  set hangingPunctuation(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT");
    this.writeParagraph({ hangingPunctuation: value || undefined });
  }
  get hangingList(): boolean { return this.current().paragraph.hangingList ?? false; }
  set hangingList(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT");
    this.writeParagraph({ hangingList: value || undefined });
  }
  get textCase(): "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED" {
    const value = this.current().style.textCase;
    if (!value) return "ORIGINAL";
    if (value === "smallCaps") return "SMALL_CAPS";
    if (value === "smallCapsForced") return "SMALL_CAPS_FORCED";
    return value.toUpperCase() as "UPPER" | "LOWER" | "TITLE";
  }
  set textCase(value: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED") {
    const textCase = value === "ORIGINAL" ? undefined
      : value === "SMALL_CAPS" ? "smallCaps"
        : value === "SMALL_CAPS_FORCED" ? "smallCapsForced"
          : value === "UPPER" ? "upper"
            : value === "LOWER" ? "lower"
              : value === "TITLE" ? "title"
                : null;
    if (textCase === null) throw runtimeError("INVALID_ARGUMENT");
    this.writeStyle({ textCase });
  }
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

  private write(patch: Partial<DocumentTextStyleResource>): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.setTextStyle({ ...structuredClone(resource), ...patch });
  }

  private writeStyle(patch: Partial<DocumentTextStyleResource["style"]>): void {
    const resource = this.current();
    this.write({ style: { ...structuredClone(resource.style), ...patch } });
  }

  private writeParagraph(patch: Partial<DocumentTextStyleResource["paragraph"]>): void {
    const resource = this.current();
    this.write({ paragraph: { ...structuredClone(resource.paragraph), ...patch } });
  }
}
