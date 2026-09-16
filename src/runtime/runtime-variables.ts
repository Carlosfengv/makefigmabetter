import type {
  DocumentColor,
  DocumentVariableAlias,
  DocumentVariableCollectionResource,
  DocumentVariableResolvedType,
  DocumentVariableResource,
  DocumentVariableValue,
} from "../lib/editor-protocol";
import { runtimeError } from "./runtime-errors";
import type { RuntimeSolidPaint } from "./runtime-paint";
import type { RuntimeEffect } from "./runtime-effect";

export type RuntimeVariableColor = Readonly<{ r: number; g: number; b: number; a?: number }>;
export type RuntimeVariableValue = boolean | number | string | RuntimeVariableColor | DocumentVariableAlias;

export type RuntimeVariableHost = Readonly<{
  assertOpen(): void;
  assertSynchronousDocumentAccess(): void;
  variableResource(id: string): DocumentVariableResource | undefined;
  variableCollectionResource(id: string): DocumentVariableCollectionResource | undefined;
  localVariables(type?: DocumentVariableResolvedType): readonly DocumentVariableResource[];
  allVariableResources(): readonly DocumentVariableResource[];
  resolveVariableValue(variableId: string, nodeId?: string, override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResolvedType }>;
  localVariableCollections(): readonly DocumentVariableCollectionResource[];
  allocateRuntimeId(): string;
  registerVariableCollection(collection: DocumentVariableCollectionResource): void;
  registerVariable(variable: DocumentVariableResource): void;
}>;

function runtimeColor(value: DocumentColor): RuntimeVariableColor {
  const [r, g, b] = value.components;
  return Object.freeze(value.alpha === 1 ? { r, g, b } : { r, g, b, a: value.alpha });
}

function isDocumentColor(value: DocumentVariableValue): value is DocumentColor {
  return typeof value === "object" && value !== null && "space" in value && "components" in value;
}

function runtimeValue(value: DocumentVariableValue): RuntimeVariableValue {
  if (isDocumentColor(value)) return runtimeColor(value);
  if (typeof value === "object" && value !== null) return Object.freeze({ ...value });
  return value;
}

export class RuntimeVariable {
  constructor(private readonly resource: DocumentVariableResource, private readonly host: RuntimeVariableHost) {}

  get id(): string { return this.resource.id; }
  get key(): string { return this.resource.key; }
  get remote(): boolean { return this.resource.remote; }
  get variableCollectionId(): string { return this.resource.collectionId; }
  get resolvedType(): DocumentVariableResolvedType { return this.resource.resolvedType; }
  get name(): string { return this.resource.name; }
  set name(_value: string) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get description(): string { return this.resource.description; }
  set description(_value: string) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get hiddenFromPublishing(): boolean { return this.resource.hiddenFromPublishing; }
  set hiddenFromPublishing(_value: boolean) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get scopes(): readonly string[] { return Object.freeze([...this.resource.scopes]); }
  set scopes(_value: readonly string[]) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get valuesByMode(): Readonly<Record<string, RuntimeVariableValue>> {
    return Object.freeze(Object.fromEntries(Object.entries(this.resource.valuesByMode).map(([mode, value]) => [mode, runtimeValue(value)])));
  }
  get codeSyntax(): Readonly<Record<string, string>> { return Object.freeze({}); }

  resolveForConsumer(_consumer: unknown): Readonly<{ value: RuntimeVariableValue; resolvedType: DocumentVariableResolvedType }> {
    this.host.assertOpen();
    const nodeId = _consumer && typeof _consumer === "object" && "id" in _consumer && typeof _consumer.id === "string" ? _consumer.id : undefined;
    const resolved = this.host.resolveVariableValue(this.resource.id, nodeId);
    return Object.freeze({ value: runtimeValue(resolved.value), resolvedType: resolved.resolvedType });
  }

  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> { return this.resource.key ? "CURRENT" : "UNPUBLISHED"; }
  setValueForMode(_modeId: string, _value: RuntimeVariableValue): never { void _modeId; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  setVariableCodeSyntax(_platform: string, _value: string): never { void _platform; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  removeVariableCodeSyntax(_platform: string): never { void _platform; throw runtimeError("UNSUPPORTED_FEATURE"); }
  remove(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginData(_key: string): string { void _key; return ""; }
  setPluginData(_key: string, _value: string): never { void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginDataKeys(): string[] { return []; }
  getSharedPluginData(_namespace: string, _key: string): string { void _namespace; void _key; return ""; }
  setSharedPluginData(_namespace: string, _key: string, _value: string): never { void _namespace; void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getSharedPluginDataKeys(_namespace: string): string[] { void _namespace; return []; }
}

export class RuntimeVariableCollection {
  constructor(private readonly resource: DocumentVariableCollectionResource, private readonly host: RuntimeVariableHost) {}

  get id(): string { return this.resource.id; }
  get key(): string { return this.resource.key; }
  get remote(): boolean { return this.resource.remote; }
  get isExtension(): false { return false; }
  get name(): string { return this.resource.name; }
  set name(_value: string) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get hiddenFromPublishing(): boolean { return this.resource.hiddenFromPublishing; }
  set hiddenFromPublishing(_value: boolean) { throw runtimeError("UNSUPPORTED_FEATURE"); }
  get modes(): readonly Readonly<{ modeId: string; name: string }>[] { return Object.freeze(this.resource.modes.map((mode) => Object.freeze({ ...mode }))); }
  get defaultModeId(): string { return this.resource.defaultModeId; }
  get variableIds(): readonly string[] {
    return Object.freeze(this.host.allVariableResources().filter((variable) => variable.collectionId === this.id).map((variable) => variable.id));
  }
  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> { return this.resource.key ? "CURRENT" : "UNPUBLISHED"; }
  addMode(_name: string): never { void _name; throw runtimeError("UNSUPPORTED_FEATURE"); }
  renameMode(_modeId: string, _name: string): never { void _modeId; void _name; throw runtimeError("UNSUPPORTED_FEATURE"); }
  removeMode(_modeId: string): never { void _modeId; throw runtimeError("UNSUPPORTED_FEATURE"); }
  remove(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginData(_key: string): string { void _key; return ""; }
  setPluginData(_key: string, _value: string): never { void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginDataKeys(): string[] { return []; }
  getSharedPluginData(_namespace: string, _key: string): string { void _namespace; void _key; return ""; }
  setSharedPluginData(_namespace: string, _key: string, _value: string): never { void _namespace; void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getSharedPluginDataKeys(_namespace: string): string[] { void _namespace; return []; }
}

export class RuntimeVariablesAPI {
  constructor(private readonly host: RuntimeVariableHost) {}

  getVariableById(id: string): RuntimeVariable | null {
    this.host.assertSynchronousDocumentAccess();
    return this.variable(id);
  }
  async getVariableByIdAsync(id: string): Promise<RuntimeVariable | null> { await Promise.resolve(); return this.variable(id); }
  getVariableCollectionById(id: string): RuntimeVariableCollection | null {
    this.host.assertSynchronousDocumentAccess();
    return this.collection(id);
  }
  async getVariableCollectionByIdAsync(id: string): Promise<RuntimeVariableCollection | null> { await Promise.resolve(); return this.collection(id); }
  getLocalVariables(type?: DocumentVariableResolvedType): readonly RuntimeVariable[] {
    this.host.assertSynchronousDocumentAccess();
    return this.locals(type);
  }
  async getLocalVariablesAsync(type?: DocumentVariableResolvedType): Promise<readonly RuntimeVariable[]> { await Promise.resolve(); return this.locals(type); }
  getLocalVariableCollections(): readonly RuntimeVariableCollection[] {
    this.host.assertSynchronousDocumentAccess();
    return this.localCollections();
  }
  async getLocalVariableCollectionsAsync(): Promise<readonly RuntimeVariableCollection[]> { await Promise.resolve(); return this.localCollections(); }
  createVariableAlias(variable: RuntimeVariable): DocumentVariableAlias {
    const current = this.host.variableResource(variable.id);
    if (!current) throw runtimeError("RESOURCE_UNAVAILABLE");
    return Object.freeze({ type: "VARIABLE_ALIAS", id: current.id });
  }
  setBoundVariableForPaint(paint: RuntimeSolidPaint, field: "color", variable: RuntimeVariable | null): RuntimeSolidPaint {
    this.host.assertOpen();
    if (!paint || paint.type !== "SOLID" || field !== "color") throw runtimeError("INVALID_ARGUMENT");
    const bindings = { ...paint.boundVariables };
    if (variable === null) delete bindings.color;
    else {
      const resource = this.host.variableResource(variable.id);
      if (!resource || resource.resolvedType !== "COLOR") throw runtimeError("INVALID_ARGUMENT");
      bindings.color = { type: "VARIABLE_ALIAS", id: resource.id };
    }
    const { boundVariables: _boundVariables, ...base } = paint;
    void _boundVariables;
    return Object.freeze({
      ...base,
      color: Object.freeze({ ...paint.color }),
      ...(bindings.color ? { boundVariables: Object.freeze(bindings) } : {}),
    });
  }
  setBoundVariableForEffect(effect: RuntimeEffect, field: "color" | "radius" | "spread" | "offsetX" | "offsetY", variable: RuntimeVariable | null): RuntimeEffect {
    this.host.assertOpen();
    const shadow = effect?.type === "DROP_SHADOW" || effect?.type === "INNER_SHADOW";
    if (!effect || !["color", "radius", "spread", "offsetX", "offsetY"].includes(field) || (!shadow && effect.type !== "LAYER_BLUR" && effect.type !== "BACKGROUND_BLUR") || (!shadow && field !== "radius")) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    const bindings = { ...effect.boundVariables };
    if (variable === null) delete bindings[field];
    else {
      const resource = this.host.variableResource(variable.id);
      const expected = field === "color" ? "COLOR" : "FLOAT";
      if (!resource || resource.resolvedType !== expected) throw runtimeError("INVALID_ARGUMENT");
      bindings[field] = { type: "VARIABLE_ALIAS", id: resource.id };
    }
    const { boundVariables: _boundVariables, ...base } = effect;
    void _boundVariables;
    return Object.freeze({
      ...base,
      ...(shadow ? { color: Object.freeze({ ...effect.color }), offset: Object.freeze({ ...effect.offset }) } : {}),
      ...(Object.keys(bindings).length ? { boundVariables: Object.freeze(bindings) } : {}),
    }) as RuntimeEffect;
  }
  async createVariableAliasByIdAsync(id: string): Promise<DocumentVariableAlias> {
    const variable = this.host.variableResource(id);
    if (!variable) throw runtimeError("RESOURCE_UNAVAILABLE");
    return Object.freeze({ type: "VARIABLE_ALIAS", id: variable.id });
  }
  createVariable(name: string, collection: RuntimeVariableCollection | string, resolvedType: DocumentVariableResolvedType): RuntimeVariable {
    this.host.assertOpen();
    if (typeof name !== "string" || !name.trim() || !["BOOLEAN", "COLOR", "FLOAT", "STRING"].includes(resolvedType)) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    const collectionId = typeof collection === "string" ? collection : collection instanceof RuntimeVariableCollection ? collection.id : "";
    const collectionResource = this.host.variableCollectionResource(collectionId);
    if (!collectionResource || collectionResource.remote) throw runtimeError("INVALID_ARGUMENT");
    const initialValue: DocumentVariableValue = resolvedType === "BOOLEAN"
      ? false
      : resolvedType === "COLOR"
        ? { space: "srgb", components: [0, 0, 0], alpha: 1 }
        : resolvedType === "FLOAT"
          ? 0
          : "";
    const resource: DocumentVariableResource = {
      id: this.host.allocateRuntimeId(),
      key: "",
      name,
      description: "",
      remote: false,
      hiddenFromPublishing: false,
      collectionId,
      resolvedType,
      valuesByMode: Object.fromEntries(collectionResource.modes.map((mode) => [mode.modeId, structuredClone(initialValue)])),
      scopes: ["ALL_SCOPES"],
    };
    this.host.registerVariable(resource);
    return new RuntimeVariable(resource, this.host);
  }
  createVariableCollection(name: string): RuntimeVariableCollection {
    this.host.assertOpen();
    if (typeof name !== "string" || !name.trim()) throw runtimeError("INVALID_ARGUMENT");
    const modeId = this.host.allocateRuntimeId();
    const resource: DocumentVariableCollectionResource = {
      id: this.host.allocateRuntimeId(),
      key: "",
      name,
      remote: false,
      hiddenFromPublishing: false,
      modes: [{ modeId, name: "Mode 1" }],
      defaultModeId: modeId,
    };
    this.host.registerVariableCollection(resource);
    return new RuntimeVariableCollection(resource, this.host);
  }
  importVariableByKeyAsync(): Promise<never> { return Promise.reject(runtimeError("UNSUPPORTED_FEATURE")); }

  private variable(id: string): RuntimeVariable | null {
    this.host.assertOpen();
    if (typeof id !== "string" || !id) throw runtimeError("INVALID_ARGUMENT");
    const value = this.host.variableResource(id);
    return value ? new RuntimeVariable(value, this.host) : null;
  }
  private collection(id: string): RuntimeVariableCollection | null {
    this.host.assertOpen();
    if (typeof id !== "string" || !id) throw runtimeError("INVALID_ARGUMENT");
    const value = this.host.variableCollectionResource(id);
    return value ? new RuntimeVariableCollection(value, this.host) : null;
  }
  private locals(type?: DocumentVariableResolvedType): readonly RuntimeVariable[] {
    this.host.assertOpen();
    if (type !== undefined && !["BOOLEAN", "COLOR", "FLOAT", "STRING"].includes(type)) throw runtimeError("INVALID_ARGUMENT");
    return Object.freeze(this.host.localVariables(type).map((value) => new RuntimeVariable(value, this.host)));
  }
  private localCollections(): readonly RuntimeVariableCollection[] {
    this.host.assertOpen();
    return Object.freeze(this.host.localVariableCollections().map((value) => new RuntimeVariableCollection(value, this.host)));
  }
}
