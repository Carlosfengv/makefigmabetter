import type { DocumentColor, DocumentGridStyleResource, DocumentLayoutGrid } from "../lib/editor-protocol";
import { runtimeError } from "./runtime-errors";
import { runtimeStyleDocumentationLinks } from "./runtime-style-metadata";

export type RuntimeLayoutGrid =
  | Readonly<{ pattern: "ROWS" | "COLUMNS"; alignment: "MIN" | "MAX" | "STRETCH" | "CENTER"; sectionSize: number; count: number; gutterSize: number; offset: number; visible: boolean; color: Readonly<{ r: number; g: number; b: number; a: number }> }>
  | Readonly<{ pattern: "GRID"; sectionSize: number; visible: boolean; color: Readonly<{ r: number; g: number; b: number; a: number }> }>;

export type RuntimeGridStyleHost = Readonly<{
  gridStyleResource(styleId: string): DocumentGridStyleResource | undefined;
  setGridStyle(style: DocumentGridStyleResource): void;
  deleteGridStyle(styleId: string): void;
  getPluginData(styleId: string, key: string): string;
  setPluginData(styleId: string, key: string, value: string): void;
  getPluginDataKeys(styleId: string): readonly string[];
  getSharedPluginData(styleId: string, namespace: string, key: string): string;
  setSharedPluginData(styleId: string, namespace: string, key: string, value: string): void;
  getSharedPluginDataKeys(styleId: string, namespace: string): readonly string[];
}>;

export class RuntimeGridStyle {
  readonly type = "GRID" as const;
  private readonly styleId: string;
  constructor(resource: DocumentGridStyleResource, private readonly host: RuntimeGridStyleHost) { this.styleId = resource.id; }
  get id(): string { return this.styleId; }
  get key(): string { return this.current().key; }
  get remote(): boolean { return this.current().remote; }
  get name(): string { return this.current().name; }
  set name(value: string) { if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw runtimeError("INVALID_ARGUMENT"); this.write({ name: value }); }
  get description(): string { return this.current().description; }
  set description(value: string) { if (typeof value !== "string" || value.includes("\0")) throw runtimeError("INVALID_ARGUMENT"); this.write({ description: value }); }
  get descriptionMarkdown(): string { return this.current().descriptionMarkdown; }
  set descriptionMarkdown(value: string) { if (typeof value !== "string" || value.includes("\0")) throw runtimeError("INVALID_ARGUMENT"); this.write({ descriptionMarkdown: value }); }
  get documentationLinks(): readonly { readonly uri: string }[] { return Object.freeze(this.current().documentationLinks.map((link) => Object.freeze({ ...link }))); }
  set documentationLinks(value: readonly { readonly uri: string }[]) { this.write({ documentationLinks: runtimeStyleDocumentationLinks(value) }); }
  get layoutGrids(): readonly RuntimeLayoutGrid[] { return Object.freeze(this.current().layoutGrids.map(runtimeLayoutGrid)); }
  set layoutGrids(value: readonly RuntimeLayoutGrid[]) { if (!Array.isArray(value) || value.length > 8) throw runtimeError("INVALID_ARGUMENT"); this.write({ layoutGrids: value.map(documentLayoutGrid) }); }
  get boundVariables(): undefined { return undefined; }
  get consumers(): readonly never[] { return Object.freeze([]); }
  async getStyleConsumersAsync(): Promise<readonly never[]> { await Promise.resolve(); return Object.freeze([]); }
  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> { await Promise.resolve(); return this.current().key ? "CURRENT" : "UNPUBLISHED"; }
  remove(): void { if (this.current().remote) throw runtimeError("UNSUPPORTED_FEATURE"); this.host.deleteGridStyle(this.id); }
  getPluginData(key: string): string { return this.host.getPluginData(this.id, key); }
  setPluginData(key: string, value: string): void { this.host.setPluginData(this.id, key, value); }
  getPluginDataKeys(): readonly string[] { return this.host.getPluginDataKeys(this.id); }
  getSharedPluginData(namespace: string, key: string): string { return this.host.getSharedPluginData(this.id, namespace, key); }
  setSharedPluginData(namespace: string, key: string, value: string): void { this.host.setSharedPluginData(this.id, namespace, key, value); }
  getSharedPluginDataKeys(namespace: string): readonly string[] { return this.host.getSharedPluginDataKeys(this.id, namespace); }
  setBoundVariable(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }
  private current(): DocumentGridStyleResource { const resource = this.host.gridStyleResource(this.styleId); if (!resource) throw runtimeError("RESOURCE_UNAVAILABLE"); return resource; }
  private write(patch: Partial<DocumentGridStyleResource>): void { const resource = this.current(); if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE"); this.host.setGridStyle({ ...structuredClone(resource), ...patch }); }
}

function documentLayoutGrid(grid: RuntimeLayoutGrid): DocumentLayoutGrid {
  if (!grid || typeof grid !== "object" || typeof grid.visible !== "boolean") throw runtimeError("INVALID_ARGUMENT");
  const color = documentColor(grid.color);
  if (grid.pattern === "GRID") { positive(grid.sectionSize); return { pattern: "grid", sectionSize: grid.sectionSize, visible: grid.visible, color }; }
  if (grid.pattern !== "ROWS" && grid.pattern !== "COLUMNS") throw runtimeError("INVALID_ARGUMENT");
  if (!["MIN", "MAX", "STRETCH", "CENTER"].includes(grid.alignment)) throw runtimeError("INVALID_ARGUMENT");
  if (grid.alignment !== "STRETCH") positive(grid.sectionSize);
  nonNegative(grid.gutterSize); nonNegative(grid.offset);
  if (grid.count !== Infinity && (!Number.isInteger(grid.count) || grid.count < 1 || grid.count > 4096)) throw runtimeError("INVALID_ARGUMENT");
  return { pattern: grid.pattern.toLowerCase() as "rows" | "columns", alignment: grid.alignment.toLowerCase() as "min" | "max" | "stretch" | "center", sectionSize: grid.alignment === "STRETCH" && !Number.isFinite(grid.sectionSize) ? undefined : grid.sectionSize, count: grid.count === Infinity ? undefined : grid.count, gutterSize: grid.gutterSize, offset: grid.offset, visible: grid.visible, color };
}

function runtimeLayoutGrid(grid: DocumentLayoutGrid): RuntimeLayoutGrid {
  const color = runtimeColor(grid.color);
  if (grid.pattern === "grid") return Object.freeze({ pattern: "GRID", sectionSize: grid.sectionSize, visible: grid.visible, color });
  return Object.freeze({ pattern: grid.pattern === "rows" ? "ROWS" : "COLUMNS", alignment: grid.alignment.toUpperCase() as "MIN" | "MAX" | "STRETCH" | "CENTER", sectionSize: grid.sectionSize ?? 10, count: grid.count ?? Infinity, gutterSize: grid.gutterSize ?? 0, offset: grid.offset ?? 0, visible: grid.visible, color });
}

function documentColor(color: Readonly<{ r: number; g: number; b: number; a: number }>): DocumentColor { if (!color || [color.r, color.g, color.b, color.a].some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw runtimeError("INVALID_ARGUMENT"); return { space: "srgb", components: [color.r, color.g, color.b], alpha: color.a }; }
function runtimeColor(color?: DocumentColor): Readonly<{ r: number; g: number; b: number; a: number }> { const value = color ?? { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 0.1 }; return Object.freeze({ r: value.components[0], g: value.components[1], b: value.components[2], a: value.alpha }); }
function positive(value: number): void { if (!Number.isFinite(value) || value <= 0) throw runtimeError("INVALID_ARGUMENT"); }
function nonNegative(value: number): void { if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT"); }
