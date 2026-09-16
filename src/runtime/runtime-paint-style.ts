import type { DocumentColor, DocumentPaintStyleResource, DocumentPaintStyleVariableBinding, DocumentVariableResource, DocumentVariableValue } from "../lib/editor-protocol";
import { colorToSrgbCss } from "../lib/color-rendering";
import { documentPaintStackFromRuntime, runtimePaintsFromDocumentStack, type RuntimePaint } from "./runtime-paint";
import type { RuntimeNodeProxy } from "./node-proxy";
import { runtimeError } from "./runtime-errors";
import { runtimeStyleDocumentationLinks } from "./runtime-style-metadata";

export type RuntimePaintStyleHost = Readonly<{
  paintStyleResource(styleId: string): DocumentPaintStyleResource | undefined;
  setPaintStyle(style: DocumentPaintStyleResource): void;
  deletePaintStyle(styleId: string): void;
  hasImageHash(hash: string): boolean;
  variableResource(variableId: string): DocumentVariableResource | undefined;
  resolveVariableValue(variableId: string): Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResource["resolvedType"] }>;
  consumersForPaintStyle(styleId: string): readonly Readonly<{ node: RuntimeNodeProxy; fields: readonly string[] }>[];
  getPluginData(styleId: string, key: string): string;
  setPluginData(styleId: string, key: string, value: string): void;
  getPluginDataKeys(styleId: string): readonly string[];
  getSharedPluginData(styleId: string, namespace: string, key: string): string;
  setSharedPluginData(styleId: string, namespace: string, key: string, value: string): void;
  getSharedPluginDataKeys(styleId: string, namespace: string): readonly string[];
}>;

/** Live projection of one canonical PaintStyle resource. */
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
  get paints(): readonly RuntimePaint[] { return paintStyleRuntimePaints(this.current()); }
  set paints(value: readonly RuntimePaint[]) {
    this.write(paintStyleValueFromRuntimePaints(
      value,
      (hash) => this.host.hasImageHash(hash),
      (id) => this.host.variableResource(id),
      (id) => this.host.resolveVariableValue(id),
    ));
  }
  get boundVariables(): Readonly<{ paints: readonly Readonly<{ type: "VARIABLE_ALIAS"; id: string }>[] }> | undefined {
    const bindings = this.current().variableBindings ?? [];
    if (!bindings.length) return undefined;
    return Object.freeze({
      paints: Object.freeze(bindings.map((binding) => Object.freeze({ type: "VARIABLE_ALIAS" as const, id: binding.variableId }))),
    });
  }

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

  private write(patch: Partial<DocumentPaintStyleResource>): void {
    const resource = this.current();
    if (resource.remote) throw runtimeError("UNSUPPORTED_FEATURE");
    this.host.setPaintStyle({ ...structuredClone(resource), ...patch });
  }
}

export function paintStyleRuntimePaints(resource: DocumentPaintStyleResource): readonly RuntimePaint[] {
  const byTarget = new Map((resource.variableBindings ?? []).map((binding) => [paintStyleBindingKey(binding), binding.variableId]));
  return Object.freeze(runtimePaintsFromDocumentStack(resource.paints).map((paint, paintIndex) => {
    const variableId = byTarget.get(`${paintIndex}`);
    if (paint.type === "SOLID") {
      if (!variableId) return structuredClone(paint);
      return {
        ...structuredClone(paint),
        ...(resource.paints.layers[paintIndex] ? { opacity: resource.paints.layers[paintIndex]!.opacity } : {}),
        boundVariables: Object.freeze({ color: Object.freeze({ type: "VARIABLE_ALIAS" as const, id: variableId }) }),
      };
    }
    if ("gradientStops" in paint) {
      return {
        ...structuredClone(paint),
        gradientStops: paint.gradientStops.map((stop, stopIndex) => {
          const stopVariableId = byTarget.get(`${paintIndex}:${stopIndex}`);
          return stopVariableId
            ? { ...structuredClone(stop), boundVariables: Object.freeze({ color: Object.freeze({ type: "VARIABLE_ALIAS" as const, id: stopVariableId }) }) }
            : structuredClone(stop);
        }),
      } as RuntimePaint;
    }
    return structuredClone(paint);
  }));
}

export function paintStyleValueFromRuntimePaints(
  value: readonly RuntimePaint[],
  hasImageHash: (hash: string) => boolean,
  variableResource: (variableId: string) => DocumentVariableResource | undefined,
  resolveVariableValue: (variableId: string) => Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResource["resolvedType"] }>,
): Pick<DocumentPaintStyleResource, "paints" | "variableBindings"> {
  const variableBindings: DocumentPaintStyleVariableBinding[] = [];
  const colors = new Map<string, DocumentColor>();
  const unboundPaints = value.map((paint, paintIndex): RuntimePaint => {
    const alias = paint.boundVariables?.color;
    const { boundVariables: _boundVariables, ...base } = paint;
    void _boundVariables;
    if ("gradientStops" in paint) {
      if (alias) throw runtimeError("UNSUPPORTED_FEATURE");
      return {
        ...base,
        gradientStops: paint.gradientStops.map((stop, stopIndex) => {
          const stopAlias = stop.boundVariables?.color;
          const { boundVariables: _stopBoundVariables, ...stopBase } = stop;
          void _stopBoundVariables;
          if (!stopAlias) return stopBase;
          const color = resolvedPaintStyleColor(stopAlias, variableResource, resolveVariableValue);
          variableBindings.push({ paintIndex, stopIndex, variableId: stopAlias.id });
          colors.set(`${paintIndex}:${stopIndex}`, color);
          return stopBase;
        }),
      } as RuntimePaint;
    }
    if (!alias) return base as RuntimePaint;
    if (paint.type !== "SOLID") throw runtimeError("UNSUPPORTED_FEATURE");
    const color = resolvedPaintStyleColor(alias, variableResource, resolveVariableValue);
    variableBindings.push({ paintIndex, variableId: alias.id });
    colors.set(`${paintIndex}`, color);
    return base as RuntimePaint;
  });
  const paints = documentPaintStackFromRuntime(unboundPaints, hasImageHash);
  variableBindings.forEach((binding) => applyPaintStyleBindingColor(paints, binding, colors.get(paintStyleBindingKey(binding))!));
  return {
    paints,
    variableBindings: variableBindings.length ? variableBindings : undefined,
  };
}

export function materializePaintStyleVariableValues(
  resource: DocumentPaintStyleResource,
  resolveVariableValue: (variableId: string) => Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResource["resolvedType"] }>,
): DocumentPaintStyleResource {
  if (!resource.variableBindings?.length) return resource;
  const paints = structuredClone(resource.paints);
  resource.variableBindings.forEach((binding) => {
    const resolved = resolveVariableValue(binding.variableId);
    if (resolved.resolvedType !== "COLOR" || !isDocumentVariableColor(resolved.value)) throw runtimeError("INVALID_ARGUMENT");
    applyPaintStyleBindingColor(paints, binding, resolved.value);
  });
  return { ...structuredClone(resource), paints };
}

function resolvedPaintStyleColor(
  alias: Readonly<{ type: "VARIABLE_ALIAS"; id: string }>,
  variableResource: (variableId: string) => DocumentVariableResource | undefined,
  resolveVariableValue: (variableId: string) => Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResource["resolvedType"] }>,
): DocumentColor {
  if (alias.type !== "VARIABLE_ALIAS") throw runtimeError("INVALID_ARGUMENT");
  const variable = variableResource(alias.id);
  if (!variable || variable.resolvedType !== "COLOR") throw runtimeError("RESOURCE_UNAVAILABLE");
  const resolved = resolveVariableValue(alias.id);
  if (resolved.resolvedType !== "COLOR" || !isDocumentVariableColor(resolved.value)) throw runtimeError("INVALID_ARGUMENT");
  return structuredClone(resolved.value);
}

function applyPaintStyleBindingColor(
  paints: DocumentPaintStyleResource["paints"],
  binding: DocumentPaintStyleVariableBinding,
  color: DocumentColor,
): void {
  const layer = paints.layers[binding.paintIndex];
  if (!layer?.paint) throw runtimeError("INTERNAL_ERROR");
  if (binding.stopIndex === undefined) {
    if (!layer.paint.color || layer.paint.gradient || layer.paint.gradientPaint) throw runtimeError("INTERNAL_ERROR");
    layer.paint = { css: colorToSrgbCss(color), color: structuredClone(color) };
    return;
  }
  const stops = layer.paint.gradient?.stops ?? layer.paint.gradientPaint?.stops;
  const stop = stops?.[binding.stopIndex];
  if (!stop) throw runtimeError("INTERNAL_ERROR");
  stop.color = structuredClone(color);
}

function paintStyleBindingKey(binding: Pick<DocumentPaintStyleVariableBinding, "paintIndex" | "stopIndex">): string {
  return binding.stopIndex === undefined ? `${binding.paintIndex}` : `${binding.paintIndex}:${binding.stopIndex}`;
}

function isDocumentVariableColor(value: DocumentVariableValue): value is DocumentColor {
  return Boolean(value && typeof value === "object" && "space" in value && "components" in value && Array.isArray(value.components));
}
