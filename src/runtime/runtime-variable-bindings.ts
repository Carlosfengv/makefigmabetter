import type { DocumentVariableAlias } from "../lib/editor-protocol";
import { runtimeError } from "./runtime-errors";

export const VARIABLE_BINDINGS_EXTENSION = "makefigma.variables.bindings.v1";
export const VARIABLE_MODES_EXTENSION = "makefigma.variables.modes.v1";
export const VARIABLE_PAINT_BINDINGS_EXTENSION = "makefigma.variables.paint-bindings.v1";
export const VARIABLE_EFFECT_BINDINGS_EXTENSION = "makefigma.variables.effect-bindings.v1";
export const VARIABLE_COMPONENT_PROPERTY_BINDINGS_EXTENSION = "makefigma.variables.component-property-bindings.v1";
const MAX_EXTENSION_ENTRIES = 64;
const MAX_EXTENSION_BYTES = 32 * 1024;

export type RuntimeVariableBindings = Readonly<Record<string, string>>;
export type RuntimeVariableModes = Readonly<Record<string, string>>;
export type RuntimeVariablePaintBindings = Readonly<Record<string, string>>;
export type RuntimeVariableEffectBindings = Readonly<Record<string, string>>;
export type RuntimeVariableComponentPropertyBindings = Readonly<Record<string, string>>;

function decodeMap(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > MAX_EXTENSION_BYTES || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(value)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed);
    if (entries.length > MAX_EXTENSION_ENTRIES || entries.some(([key, item]) => !key || key.length > 256 || typeof item !== "string" || !item || item.length > 2_048)) return {};
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
  } catch {
    return {};
  }
}

export function variableBindingsFromExtensions(extensions: unknown): RuntimeVariableBindings {
  if (!extensions || typeof extensions !== "object") return Object.freeze({});
  return Object.freeze(decodeMap((extensions as Record<string, unknown>)[VARIABLE_BINDINGS_EXTENSION]));
}

export function variableModesFromExtensions(extensions: unknown): RuntimeVariableModes {
  if (!extensions || typeof extensions !== "object") return Object.freeze({});
  return Object.freeze(decodeMap((extensions as Record<string, unknown>)[VARIABLE_MODES_EXTENSION]));
}

export function variablePaintBindingsFromExtensions(extensions: unknown): RuntimeVariablePaintBindings {
  if (!extensions || typeof extensions !== "object") return Object.freeze({});
  return Object.freeze(decodeMap((extensions as Record<string, unknown>)[VARIABLE_PAINT_BINDINGS_EXTENSION]));
}

export function variableEffectBindingsFromExtensions(extensions: unknown): RuntimeVariableEffectBindings {
  if (!extensions || typeof extensions !== "object") return Object.freeze({});
  return Object.freeze(decodeMap((extensions as Record<string, unknown>)[VARIABLE_EFFECT_BINDINGS_EXTENSION]));
}

export function variableComponentPropertyBindingsFromExtensions(extensions: unknown): RuntimeVariableComponentPropertyBindings {
  if (!extensions || typeof extensions !== "object") return Object.freeze({});
  return Object.freeze(decodeMap((extensions as Record<string, unknown>)[VARIABLE_COMPONENT_PROPERTY_BINDINGS_EXTENSION]));
}

export function variableAliases(bindings: RuntimeVariableBindings): Readonly<Record<string, DocumentVariableAlias>> {
  return Object.freeze(Object.fromEntries(Object.entries(bindings).map(([field, id]) => [field, Object.freeze({ type: "VARIABLE_ALIAS" as const, id })])));
}

export function extensionsWithVariableMap(extensions: unknown, key: typeof VARIABLE_BINDINGS_EXTENSION | typeof VARIABLE_MODES_EXTENSION | typeof VARIABLE_PAINT_BINDINGS_EXTENSION | typeof VARIABLE_EFFECT_BINDINGS_EXTENSION | typeof VARIABLE_COMPONENT_PROPERTY_BINDINGS_EXTENSION, values: Readonly<Record<string, string>>): Record<string, number[]> {
  const next: Record<string, number[]> = {};
  if (extensions && typeof extensions === "object") {
    for (const [entryKey, value] of Object.entries(extensions as Record<string, unknown>)) {
      if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) next[entryKey] = [...value] as number[];
    }
  }
  const ordered = Object.fromEntries(Object.entries(values).filter(([field, value]) => field && value).sort(([a], [b]) => a.localeCompare(b)));
  if (Object.keys(ordered).length > MAX_EXTENSION_ENTRIES) throw runtimeError("RESOURCE_LIMIT");
  if (Object.keys(ordered).length === 0) delete next[key];
  else {
    const bytes = [...new TextEncoder().encode(JSON.stringify(ordered))];
    if (bytes.length > MAX_EXTENSION_BYTES) throw runtimeError("RESOURCE_LIMIT");
    next[key] = bytes;
  }
  return next;
}
