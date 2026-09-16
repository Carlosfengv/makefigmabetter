import type {
  DocumentColor,
  DocumentVariableAlias,
  DocumentVariableCollectionResource,
  DocumentVariableResolvedType,
  DocumentVariableResource,
  DocumentVariableValue,
} from "../lib/editor-protocol";
import { runtimeError } from "./runtime-errors";

export type RuntimeVariableColor = Readonly<{ r: number; g: number; b: number; a?: number }>;
export type RuntimeVariableValue = boolean | number | string | RuntimeVariableColor | DocumentVariableAlias;

export type RuntimeVariableHost = Readonly<{
  assertOpen(): void;
  assertSynchronousDocumentAccess(): void;
  variableResource(id: string): DocumentVariableResource | undefined;
  variableCollectionResource(id: string): DocumentVariableCollectionResource | undefined;
  localVariables(type?: DocumentVariableResolvedType): readonly DocumentVariableResource[];
  allVariableResources(): readonly DocumentVariableResource[];
  localVariableCollections(): readonly DocumentVariableCollectionResource[];
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
    void _consumer;
    this.host.assertOpen();
    const seen = new Set<string>();
    let variable: DocumentVariableResource = this.resource;
    while (true) {
      if (seen.has(variable.id)) throw runtimeError("INVALID_ARGUMENT");
      seen.add(variable.id);
      const collection = this.host.variableCollectionResource(variable.collectionId);
      if (!collection) throw runtimeError("RESOURCE_UNAVAILABLE");
      const value = variable.valuesByMode[collection.defaultModeId];
      if (value === undefined) throw runtimeError("RESOURCE_UNAVAILABLE");
      if (typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS") {
        const target = this.host.variableResource(value.id);
        if (!target || target.resolvedType !== this.resource.resolvedType) throw runtimeError("RESOURCE_UNAVAILABLE");
        variable = target;
        continue;
      }
      return Object.freeze({ value: runtimeValue(value), resolvedType: this.resource.resolvedType });
    }
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
  async createVariableAliasByIdAsync(id: string): Promise<DocumentVariableAlias> {
    const variable = this.host.variableResource(id);
    if (!variable) throw runtimeError("RESOURCE_UNAVAILABLE");
    return Object.freeze({ type: "VARIABLE_ALIAS", id: variable.id });
  }
  createVariable(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }
  createVariableCollection(): never { throw runtimeError("UNSUPPORTED_FEATURE"); }
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
