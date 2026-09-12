import { runtimeError } from "./runtime-errors";
import type { RuntimeProjectionNode } from "./runtime-projection-store";
import type { RuntimeNodeHandle } from "./node-registry";
import type { DocumentFontReference } from "../lib/editor-protocol";
import { fontsForRuntimeTextRange, patchRuntimeTextRange, replaceRuntimeTextRange, updateRuntimeText, type RuntimeTextStylePatch } from "./runtime-text";
import type { RuntimeImage } from "./runtime-session";
import { type PrototypeMetadata, type PrototypeReaction, validatePrototypeMetadata, validatePrototypeReactions } from "./prototype-contract";
import type { RuntimeExportSettings, RuntimePngExportSettings, RuntimeSvgExportSettings } from "./runtime-svg-export";

export const M1_NODE_TYPES = ["DOCUMENT", "PAGE", "FRAME", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE", "LINE", "TEXT", "IMAGE"] as const;
export type M1NodeType = (typeof M1_NODE_TYPES)[number];
export type M1SceneNodeType = Exclude<M1NodeType, "DOCUMENT" | "PAGE">;
export type RuntimeLayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL";

type RuntimeAutoLayout = Readonly<{
  mode: "none" | "horizontal" | "vertical";
  padding: [number, number, number, number];
  itemSpacing: number;
  wrap: boolean;
  primaryAlignment: "start" | "center" | "end" | "spaceBetween";
  counterAlignment: "start" | "center" | "end";
  primarySizing: "fixed" | "hug" | "fill";
  counterSizing: "fixed" | "hug" | "fill";
  absolute: boolean;
}>;

export interface RuntimeNodeHost {
  assertOpen(): void;
  isCurrent(handle: RuntimeNodeHandle): boolean;
  readNode(handle: RuntimeNodeHandle): RuntimeProjectionNode | undefined;
  proxyFor(nodeId: string): RuntimeNodeProxy;
  hasLiveNode(nodeId: string): boolean;
  enqueueUpdate(nodeId: string, patch: Readonly<Record<string, unknown>>): void;
  enqueueRemove(nodeId: string): void;
  commitAsync(): Promise<number>;
  cloneNode(nodeId: string): RuntimeNodeProxy;
  exportNodeSvgString(nodeId: string): Promise<string>;
  exportNodePng(nodeId: string, settings: RuntimePngExportSettings): Promise<Uint8Array>;
  assertFontsLoaded(fonts: readonly DocumentFontReference[]): void;
}

/** Figma-compatible core proxy for M1. It deliberately reads the session's
 * composed projection for every getter instead of storing a mutable node copy. */
export class RuntimeNodeProxy {
  constructor(
    readonly handle: RuntimeNodeHandle,
    protected readonly host: RuntimeNodeHost,
    private readonly nodeType: M1NodeType,
  ) {}

  get id(): string {
    this.host.assertOpen();
    return this.handle.nodeId;
  }

  get type(): M1NodeType {
    this.host.assertOpen();
    return this.nodeType;
  }

  get removed(): boolean {
    this.host.assertOpen();
    return !this.host.isCurrent(this.handle) || this.host.readNode(this.handle)?.removed === true || this.host.readNode(this.handle) === undefined;
  }

  get name(): string { return this.string("name"); }
  set name(value: string) {
    if (!value.trim()) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ name: value });
  }

  get x(): number { return this.number("x"); }
  set x(value: number) { this.writeFinite("x", value); }
  get y(): number { return this.number("y"); }
  set y(value: number) { this.writeFinite("y", value); }
  get width(): number { return this.number("width"); }
  get height(): number { return this.number("height"); }
  get rotation(): number { return this.number("rotation"); }
  set rotation(value: number) { this.writeFinite("rotation", value); }
  get opacity(): number { return this.number("opacity"); }
  set opacity(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ opacity: value });
  }
  get parent(): RuntimeNodeProxy | null {
    const parentId = this.read().parentId;
    return typeof parentId === "string" ? this.host.proxyFor(parentId) : null;
  }

  get characters(): string {
    this.assertText();
    const value = this.read().characters;
    return typeof value === "string" ? value : "";
  }
  set characters(value: string) {
    this.assertText();
    const node = this.read();
    const before = typeof node.characters === "string" ? node.characters : "";
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, node.textProperties as never));
    const next = updateRuntimeText(before, value, node.textProperties as never);
    this.write(next);
  }

  /** Applies a common Figma Text range property using UTF-16 API offsets. */
  setRangeFontSize(start: number, end: number, fontSize: number): void {
    if (!Number.isFinite(fontSize) || fontSize <= 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { fontSize });
  }

  /** Runtime's asset-addressed equivalent of Figma's font-name range setter.
   * The AssetId is explicit because Canonical text never persists raw family
   * names or font bytes. */
  setRangeFontReference(start: number, end: number, font: DocumentFontReference): void {
    if (!font.assetId || !Number.isSafeInteger(font.faceIndex) || font.faceIndex < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.setTextRange(start, end, { font: structuredClone(font) });
  }

  insertCharacters(start: number, characters: string): void {
    this.replaceCharacters(start, start, characters);
  }

  deleteCharacters(start: number, end: number): void {
    this.replaceCharacters(start, end, "");
  }

  setRangeCharacters(start: number, end: number, characters: string): void {
    this.replaceCharacters(start, end, characters);
  }

  /** Binds an admitted Runtime image to a paint-capable M2 node. The image
   * bytes are never copied into a PendingProjection or Canonical snapshot. */
  setImageAsset(image: RuntimeImage): void {
    if (!image.hash || this.type !== "IMAGE") {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
    this.write({ assetId: image.hash });
  }

  get imageHash(): string | null {
    const assetId = this.read().assetId;
    return typeof assetId === "string" ? assetId : null;
  }

  /** M3's ordered prototype reactions. Unsupported imported reactions are
   * omitted by the Core projection rather than claimed to be playable. */
  get reactions(): readonly PrototypeReaction[] {
    const reactions = this.read().reactions;
    return Array.isArray(reactions) ? validatePrototypeReactions(reactions as PrototypeReaction[]) : [];
  }

  /** Persists the complete reaction list as one Core transaction and resolves
   * only after its Ack + projection fence. */
  async setReactionsAsync(reactions: readonly PrototypeReaction[]): Promise<void> {
    this.assertLive();
    const known = new Set(reactions.flatMap((reaction) => reaction.actions.flatMap((action) => (action.type === "NODE" || action.type === "CHANGE_TO") && action.destinationId ? [action.destinationId] : [])));
    known.forEach((id) => { if (!this.host.hasLiveNode(id)) throw runtimeError("NODE_NOT_FOUND", { nodeId: id }); });
    const next = validatePrototypeReactions(reactions, known);
    this.write({ reactions: next });
    await this.host.commitAsync();
  }

  get prototypeMetadata(): PrototypeMetadata | undefined {
    return validatePrototypeMetadata(this.read().prototypeMetadata as PrototypeMetadata | undefined);
  }

  async setPrototypeMetadataAsync(metadata: PrototypeMetadata | undefined): Promise<void> {
    this.assertLive();
    if (this.type !== "FRAME") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    this.write({ prototypeMetadata: validatePrototypeMetadata(metadata) });
    await this.host.commitAsync();
  }

  /** M1's supported Figma Auto Layout subset. GRID and advanced wrapping
   * controls remain outside the Runtime's declared capability surface. */
  get layoutMode(): RuntimeLayoutMode {
    const mode = this.autoLayout().mode;
    return mode === "horizontal" ? "HORIZONTAL" : mode === "vertical" ? "VERTICAL" : "NONE";
  }
  set layoutMode(value: RuntimeLayoutMode) {
    if (this.type !== "FRAME" || !["NONE", "HORIZONTAL", "VERTICAL"].includes(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ mode: value.toLowerCase() as RuntimeAutoLayout["mode"] });
  }

  get paddingTop(): number { return this.autoLayout().padding[0]; }
  set paddingTop(value: number) { this.writePadding(0, value); }
  get paddingRight(): number { return this.autoLayout().padding[1]; }
  set paddingRight(value: number) { this.writePadding(1, value); }
  get paddingBottom(): number { return this.autoLayout().padding[2]; }
  set paddingBottom(value: number) { this.writePadding(2, value); }
  get paddingLeft(): number { return this.autoLayout().padding[3]; }
  set paddingLeft(value: number) { this.writePadding(3, value); }
  get itemSpacing(): number { return this.autoLayout().itemSpacing; }
  set itemSpacing(value: number) {
    if (!Number.isFinite(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.assertAutoLayoutFrame();
    this.writeAutoLayout({ itemSpacing: value });
  }

  resize(width: number, height: number): void {
    if (![width, height].every((value) => Number.isFinite(value) && value >= 0)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.write({ width, height });
  }

  remove(): void {
    this.assertLive();
    this.host.enqueueRemove(this.handle.nodeId);
  }

  clone(): RuntimeNodeProxy {
    this.assertLive();
    return this.host.cloneNode(this.handle.nodeId);
  }

  /** Figma-shaped M4D export entry. The result is derived from a confirmed,
   * RevisionLease-frozen scene rather than this proxy's pending local overlay. */
  exportAsync(settings: RuntimeSvgExportSettings): Promise<string>;
  exportAsync(settings: RuntimePngExportSettings): Promise<Uint8Array>;
  exportAsync(settings: RuntimeExportSettings): Promise<string | Uint8Array> {
    this.assertLive();
    if (settings?.format === "SVG_STRING") return this.host.exportNodeSvgString(this.handle.nodeId);
    if (settings?.format === "PNG") return this.host.exportNodePng(this.handle.nodeId, settings);
    throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: this.handle.nodeId });
  }

  protected read(allowRemoved = false): RuntimeProjectionNode {
    this.host.assertOpen();
    const node = this.host.readNode(this.handle);
    if (!node || !this.host.isCurrent(this.handle) || (node.removed === true && !allowRemoved)) {
      throw runtimeError("NODE_REMOVED", { nodeId: this.handle.nodeId });
    }
    return node;
  }

  protected assertLive(): void { this.read(); }

  private string(property: string): string {
    const value = this.read()[property];
    return typeof value === "string" ? value : "";
  }

  private number(property: string): number {
    const value = this.read()[property];
    return typeof value === "number" ? value : 0;
  }

  private writeFinite(property: string, value: number): void {
    if (!Number.isFinite(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ [property]: value });
  }

  protected write(patch: Readonly<Record<string, unknown>>): void {
    this.assertLive();
    this.host.enqueueUpdate(this.handle.nodeId, patch);
  }

  private assertAutoLayoutFrame(): void {
    if (this.type !== "FRAME") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
  }

  private assertText(): void {
    if (this.type !== "TEXT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private setTextRange(start: number, end: number, patch: RuntimeTextStylePatch): void {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as never;
    const fonts = [
      ...fontsForRuntimeTextRange(text, properties, start, end),
      ...(patch.font ? [patch.font] : []),
    ];
    this.host.assertFontsLoaded(fonts);
    this.write({ textProperties: patchRuntimeTextRange(text, properties, start, end, patch) });
  }

  private replaceCharacters(start: number, end: number, replacement: string): void {
    this.assertText();
    const node = this.read();
    const before = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as never;
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, properties, start, end));
    const next = replaceRuntimeTextRange(before, start, end, replacement);
    this.write(updateRuntimeText(before, next, properties));
  }

  private autoLayout(): RuntimeAutoLayout {
    const value = this.read().autoLayout;
    if (!value || typeof value !== "object") return defaultAutoLayout();
    const layout = value as Partial<RuntimeAutoLayout>;
    const padding = Array.isArray(layout.padding) && layout.padding.length === 4 && layout.padding.every(Number.isFinite)
      ? layout.padding as [number, number, number, number]
      : [0, 0, 0, 0];
    return {
      ...defaultAutoLayout(),
      ...layout,
      padding: [...padding] as [number, number, number, number],
    };
  }

  private writePadding(index: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.assertAutoLayoutFrame();
    const layout = this.autoLayout();
    const padding = [...layout.padding] as [number, number, number, number];
    padding[index] = value;
    this.writeAutoLayout({ padding });
  }

  private writeAutoLayout(patch: Partial<RuntimeAutoLayout>): void {
    this.write({ autoLayout: { ...this.autoLayout(), ...patch } });
  }
}

function defaultAutoLayout(): RuntimeAutoLayout {
  return {
    mode: "none",
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    wrap: false,
    primaryAlignment: "start",
    counterAlignment: "start",
    primarySizing: "fixed",
    counterSizing: "fixed",
    absolute: false,
  };
}
