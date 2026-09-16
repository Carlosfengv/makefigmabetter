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
  setVariable(variable: DocumentVariableResource): void;
  deleteVariable(id: string): void;
  variableIsBound(id: string): boolean;
  setVariableCollection(collection: DocumentVariableCollectionResource, variables: readonly DocumentVariableResource[]): void;
  deleteVariableCollection(id: string): void;
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
  private removed = false;
  constructor(private resource: DocumentVariableResource, private readonly host: RuntimeVariableHost) {}

  get id(): string { return this.resource.id; }
  get key(): string { return this.read().key; }
  get remote(): boolean { return this.read().remote; }
  get variableCollectionId(): string { return this.read().collectionId; }
  get resolvedType(): DocumentVariableResolvedType { return this.read().resolvedType; }
  get name(): string { return this.read().name; }
  set name(value: string) {
    if (typeof value !== "string" || !value.trim()) throw runtimeError("INVALID_ARGUMENT");
    this.update({ name: value });
  }
  get description(): string { return this.read().description; }
  set description(value: string) {
    if (typeof value !== "string") throw runtimeError("INVALID_ARGUMENT");
    this.update({ description: value });
  }
  get hiddenFromPublishing(): boolean { return this.read().hiddenFromPublishing; }
  set hiddenFromPublishing(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT");
    this.update({ hiddenFromPublishing: value });
  }
  get scopes(): readonly string[] { return Object.freeze([...this.read().scopes]); }
  set scopes(value: readonly string[]) {
    if (!Array.isArray(value) || value.length > 16 || value.some((scope) => typeof scope !== "string" || !scope || scope.length > 128)) throw runtimeError("INVALID_ARGUMENT");
    this.update({ scopes: [...value] });
  }
  get valuesByMode(): Readonly<Record<string, RuntimeVariableValue>> {
    return Object.freeze(Object.fromEntries(Object.entries(this.read().valuesByMode).map(([mode, value]) => [mode, runtimeValue(value)])));
  }
  get codeSyntax(): Readonly<Record<string, string>> { return Object.freeze({}); }

  resolveForConsumer(_consumer: unknown): Readonly<{ value: RuntimeVariableValue; resolvedType: DocumentVariableResolvedType }> {
    this.host.assertOpen();
    const nodeId = _consumer && typeof _consumer === "object" && "id" in _consumer && typeof _consumer.id === "string" ? _consumer.id : undefined;
    const resolved = this.host.resolveVariableValue(this.id, nodeId);
    return Object.freeze({ value: runtimeValue(resolved.value), resolvedType: resolved.resolvedType });
  }

  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> { return this.read().key ? "CURRENT" : "UNPUBLISHED"; }
  setValueForMode(modeId: string, value: RuntimeVariableValue): void {
    this.assertMutable();
    const current = this.read();
    const collection = this.host.variableCollectionResource(current.collectionId);
    if (!collection?.modes.some((mode) => mode.modeId === modeId)) throw runtimeError("INVALID_ARGUMENT");
    let documentValue: DocumentVariableValue;
    if (current.resolvedType === "BOOLEAN" && typeof value === "boolean") documentValue = value;
    else if (current.resolvedType === "FLOAT" && typeof value === "number" && Number.isFinite(value)) documentValue = value;
    else if (current.resolvedType === "STRING" && typeof value === "string") documentValue = value;
    else if (current.resolvedType === "COLOR" && isRuntimeColor(value)) {
      documentValue = { space: "srgb", components: [value.r, value.g, value.b], alpha: value.a ?? 1 };
    } else if (isVariableAlias(value)) {
      const target = this.host.variableResource(value.id);
      if (!target || target.id === this.id || target.resolvedType !== this.resolvedType) throw runtimeError("INVALID_ARGUMENT");
      documentValue = { type: "VARIABLE_ALIAS", id: target.id };
    } else throw runtimeError("INVALID_ARGUMENT");
    this.update({ valuesByMode: { ...current.valuesByMode, [modeId]: documentValue } });
  }
  setVariableCodeSyntax(_platform: string, _value: string): never { void _platform; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  removeVariableCodeSyntax(_platform: string): never { void _platform; throw runtimeError("UNSUPPORTED_FEATURE"); }
  remove(): void {
    this.assertMutable();
    if (this.host.variableIsBound(this.id)) throw runtimeError("INVALID_ARGUMENT");
    this.host.deleteVariable(this.id);
    this.removed = true;
  }
  getPluginData(_key: string): string { void _key; return ""; }
  setPluginData(_key: string, _value: string): never { void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginDataKeys(): string[] { return []; }
  getSharedPluginData(_namespace: string, _key: string): string { void _namespace; void _key; return ""; }
  setSharedPluginData(_namespace: string, _key: string, _value: string): never { void _namespace; void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getSharedPluginDataKeys(_namespace: string): string[] { void _namespace; return []; }

  private assertCurrent(): void {
    this.host.assertOpen();
    if (this.removed || !this.host.variableResource(this.id)) throw runtimeError("RESOURCE_UNAVAILABLE");
  }

  private read(): DocumentVariableResource {
    const current = this.host.variableResource(this.resource.id);
    if (current) this.resource = current;
    return this.resource;
  }

  private assertMutable(): void {
    this.assertCurrent();
    if (this.read().remote) throw runtimeError("INVALID_ARGUMENT");
  }

  private update(patch: Partial<DocumentVariableResource>): void {
    this.assertMutable();
    const next = { ...this.read(), ...patch };
    this.host.setVariable(next);
    this.resource = next;
  }
}

function isVariableAlias(value: RuntimeVariableValue): value is DocumentVariableAlias {
  return typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS" && typeof value.id === "string";
}

function isRuntimeColor(value: RuntimeVariableValue): value is RuntimeVariableColor {
  return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value
    && [value.r, value.g, value.b, value.a ?? 1].every((component) => typeof component === "number" && Number.isFinite(component) && component >= 0 && component <= 1);
}

export class RuntimeVariableCollection {
  private removed = false;
  constructor(private resource: DocumentVariableCollectionResource, private readonly host: RuntimeVariableHost) {}

  get id(): string { return this.resource.id; }
  get key(): string { return this.read().key; }
  get remote(): boolean { return this.read().remote; }
  get isExtension(): false { return false; }
  get name(): string { return this.read().name; }
  set name(value: string) { if (typeof value !== "string" || !value.trim()) throw runtimeError("INVALID_ARGUMENT"); this.update({ name: value }); }
  get hiddenFromPublishing(): boolean { return this.read().hiddenFromPublishing; }
  set hiddenFromPublishing(value: boolean) { if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT"); this.update({ hiddenFromPublishing: value }); }
  get modes(): readonly Readonly<{ modeId: string; name: string }>[] { return Object.freeze(this.read().modes.map((mode) => Object.freeze({ ...mode }))); }
  get defaultModeId(): string { return this.read().defaultModeId; }
  get variableIds(): readonly string[] {
    return Object.freeze(this.host.allVariableResources().filter((variable) => variable.collectionId === this.id).map((variable) => variable.id));
  }
  async getPublishStatusAsync(): Promise<"UNPUBLISHED" | "CURRENT"> { return this.read().key ? "CURRENT" : "UNPUBLISHED"; }
  addMode(name: string): string {
    if (typeof name !== "string" || !name.trim()) throw runtimeError("INVALID_ARGUMENT");
    const current = this.assertMutable();
    const modeId = this.host.allocateRuntimeId();
    const variables = this.collectionVariables().map((variable) => ({ ...variable, valuesByMode: { ...variable.valuesByMode, [modeId]: structuredClone(variable.valuesByMode[current.defaultModeId]) } }));
    this.commit({ ...current, modes: [...current.modes, { modeId, name }] }, variables);
    return modeId;
  }
  renameMode(modeId: string, name: string): void {
    if (typeof name !== "string" || !name.trim()) throw runtimeError("INVALID_ARGUMENT");
    const current = this.assertMutable();
    if (!current.modes.some((mode) => mode.modeId === modeId)) throw runtimeError("INVALID_ARGUMENT");
    this.commit({ ...current, modes: current.modes.map((mode) => mode.modeId === modeId ? { ...mode, name } : mode) }, this.collectionVariables());
  }
  removeMode(modeId: string): void {
    const current = this.assertMutable();
    if (current.modes.length <= 1 || modeId === current.defaultModeId || !current.modes.some((mode) => mode.modeId === modeId)) throw runtimeError("INVALID_ARGUMENT");
    const variables = this.collectionVariables().map((variable) => {
      const valuesByMode = { ...variable.valuesByMode };
      delete valuesByMode[modeId];
      return { ...variable, valuesByMode };
    });
    this.commit({ ...current, modes: current.modes.filter((mode) => mode.modeId !== modeId) }, variables);
  }
  remove(): void {
    this.assertMutable();
    if (this.collectionVariables().some((variable) => this.host.variableIsBound(variable.id))) throw runtimeError("INVALID_ARGUMENT");
    this.host.deleteVariableCollection(this.id);
    this.removed = true;
  }
  getPluginData(_key: string): string { void _key; return ""; }
  setPluginData(_key: string, _value: string): never { void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getPluginDataKeys(): string[] { return []; }
  getSharedPluginData(_namespace: string, _key: string): string { void _namespace; void _key; return ""; }
  setSharedPluginData(_namespace: string, _key: string, _value: string): never { void _namespace; void _key; void _value; throw runtimeError("UNSUPPORTED_FEATURE"); }
  getSharedPluginDataKeys(_namespace: string): string[] { void _namespace; return []; }

  private read(): DocumentVariableCollectionResource {
    const current = this.host.variableCollectionResource(this.resource.id);
    if (current) this.resource = current;
    return this.resource;
  }
  private assertMutable(): DocumentVariableCollectionResource {
    this.host.assertOpen();
    const current = this.host.variableCollectionResource(this.id);
    if (this.removed || !current) throw runtimeError("RESOURCE_UNAVAILABLE");
    if (current.remote) throw runtimeError("INVALID_ARGUMENT");
    this.resource = current;
    return current;
  }
  private collectionVariables(): DocumentVariableResource[] {
    return this.host.allVariableResources().filter((variable) => variable.collectionId === this.id).map((variable) => structuredClone(variable));
  }
  private update(patch: Partial<DocumentVariableCollectionResource>): void {
    const current = this.assertMutable();
    this.commit({ ...current, ...patch }, this.collectionVariables());
  }
  private commit(collection: DocumentVariableCollectionResource, variables: readonly DocumentVariableResource[]): void {
    this.host.setVariableCollection(collection, variables);
    this.resource = collection;
  }
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
