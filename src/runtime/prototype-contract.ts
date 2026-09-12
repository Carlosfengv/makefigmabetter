import { runtimeError } from "./runtime-errors";

/**
 * The M3 prototype subset is deliberately closed.  Values outside it are not
 * silently treated as playable merely because they can be preserved by Figma
 * imports.  These records are JSON-safe so they can live in Canonical node
 * extensions until the wire schema promotes them to first-class fields.
 */
export type PrototypeTrigger =
  | Readonly<{ type: "ON_CLICK" | "ON_PRESS" | "ON_HOVER" }>
  | Readonly<{ type: "AFTER_TIMEOUT"; timeout: number }>;

export type PrototypeTransition =
  | Readonly<{ type: "NONE" }>
  | Readonly<{ type: "DISSOLVE"; duration: number; easing?: "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" }>
  | Readonly<{ type: "DIRECTIONAL"; direction: "LEFT" | "RIGHT" | "UP" | "DOWN"; duration: number; easing?: "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" }>
  | Readonly<{ type: "SMART_ANIMATE"; duration: number; easing?: "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" }>;

export type PrototypeAction =
  | Readonly<{ type: "NODE"; navigation: "NAVIGATE" | "OVERLAY"; destinationId: string | null; transition?: PrototypeTransition | null; overlayRelativePosition?: Readonly<{ x: number; y: number }> }>
  | Readonly<{ type: "CHANGE_TO"; destinationId: string | null; transition?: PrototypeTransition | null }>
  | Readonly<{ type: "BACK" | "CLOSE" }>
  | Readonly<{ type: "URL"; url: string }>;

export type PrototypeReaction = Readonly<{ trigger: PrototypeTrigger; actions: readonly PrototypeAction[] }>;

export type PrototypeMetadata = Readonly<{
  /** A Frame/Slide may opt in as a stable flow entry.  The lowest ordered
   * opted-in frame otherwise becomes the deterministic default. */
  startingPoint?: boolean;
  overlay?: Readonly<{
    positionType: "CENTER" | "MANUAL";
    relativePosition?: Readonly<{ x: number; y: number }>;
    backgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" | "DO_NOTHING";
  }>;
}>;

export const PROTOTYPE_REACTIONS_EXTENSION = "makefigma.prototype.reactions.v1";
export const PROTOTYPE_METADATA_EXTENSION = "makefigma.prototype.metadata.v1";
export const MAX_PROTOTYPE_REACTIONS = 128;
export const MAX_PROTOTYPE_ACTIONS = 16;
export const MAX_PROTOTYPE_DURATION_MS = 60_000;

export function validatePrototypeReactions(reactions: readonly PrototypeReaction[], knownNodeIds?: ReadonlySet<string>): readonly PrototypeReaction[] {
  if (!Array.isArray(reactions) || reactions.length > MAX_PROTOTYPE_REACTIONS) throw runtimeError("INVALID_ARGUMENT");
  const copy = structuredClone(reactions) as PrototypeReaction[];
  for (const reaction of copy) {
    if (!reaction || !validTrigger(reaction.trigger) || !Array.isArray(reaction.actions) || reaction.actions.length === 0 || reaction.actions.length > MAX_PROTOTYPE_ACTIONS) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    reaction.actions.forEach((action) => validateAction(action, knownNodeIds));
  }
  return Object.freeze(copy.map((reaction) => Object.freeze({ trigger: Object.freeze(reaction.trigger), actions: Object.freeze(reaction.actions.map((action) => Object.freeze(action))) })));
}

export function validatePrototypeMetadata(metadata: PrototypeMetadata | undefined): PrototypeMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (!metadata || typeof metadata !== "object" || (metadata.startingPoint !== undefined && typeof metadata.startingPoint !== "boolean")) throw runtimeError("INVALID_ARGUMENT");
  const overlay = metadata.overlay;
  if (overlay) {
    if (!["CENTER", "MANUAL"].includes(overlay.positionType) || !["CLOSE_ON_CLICK_OUTSIDE", "DO_NOTHING"].includes(overlay.backgroundInteraction)) throw runtimeError("INVALID_ARGUMENT");
    if (overlay.positionType === "MANUAL" && (!overlay.relativePosition || !Number.isFinite(overlay.relativePosition.x) || !Number.isFinite(overlay.relativePosition.y))) throw runtimeError("INVALID_ARGUMENT");
    if (overlay.relativePosition && (!Number.isFinite(overlay.relativePosition.x) || !Number.isFinite(overlay.relativePosition.y))) throw runtimeError("INVALID_ARGUMENT");
  }
  return Object.freeze(structuredClone(metadata));
}

export function encodePrototypeValue(value: unknown): number[] {
  return [...new TextEncoder().encode(JSON.stringify(value))];
}

export function decodePrototypeReactions(value: unknown): readonly PrototypeReaction[] {
  const decoded = decode(value);
  try { return validatePrototypeReactions(decoded as PrototypeReaction[]); } catch { return []; }
}

export function decodePrototypeMetadata(value: unknown): PrototypeMetadata | undefined {
  const decoded = decode(value);
  try { return validatePrototypeMetadata(decoded as PrototypeMetadata | undefined); } catch { return undefined; }
}

function decode(value: unknown): unknown {
  if (!Array.isArray(value) || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(value))); } catch { return undefined; }
}

function validTrigger(trigger: PrototypeTrigger): boolean {
  return Boolean(trigger) && (
    trigger.type === "ON_CLICK" || trigger.type === "ON_PRESS" || trigger.type === "ON_HOVER" ||
    (trigger.type === "AFTER_TIMEOUT" && Number.isFinite(trigger.timeout) && trigger.timeout >= 0 && trigger.timeout <= MAX_PROTOTYPE_DURATION_MS)
  );
}

function validateAction(action: PrototypeAction, knownNodeIds?: ReadonlySet<string>): void {
  if (!action || typeof action !== "object") throw runtimeError("INVALID_ARGUMENT");
  if (action.type === "BACK" || action.type === "CLOSE") return;
  if (action.type === "URL") {
    if (!validUrl(action.url)) throw runtimeError("URL_NOT_ALLOWED");
    return;
  }
  if (action.type === "CHANGE_TO") {
    if (action.destinationId === null || !action.destinationId) throw runtimeError("INVALID_ARGUMENT");
    if (knownNodeIds && !knownNodeIds.has(action.destinationId)) throw runtimeError("NODE_NOT_FOUND", { nodeId: action.destinationId });
    if (action.transition !== undefined && action.transition !== null) validateTransition(action.transition);
    return;
  }
  if (action.type !== "NODE" || !["NAVIGATE", "OVERLAY"].includes(action.navigation) || action.destinationId === null || !action.destinationId) throw runtimeError("INVALID_ARGUMENT");
  if (knownNodeIds && !knownNodeIds.has(action.destinationId)) throw runtimeError("NODE_NOT_FOUND", { nodeId: action.destinationId });
  if (action.overlayRelativePosition && (!Number.isFinite(action.overlayRelativePosition.x) || !Number.isFinite(action.overlayRelativePosition.y))) throw runtimeError("INVALID_ARGUMENT");
  if (action.transition !== undefined && action.transition !== null) validateTransition(action.transition);
}

function validateTransition(transition: PrototypeTransition): void {
  if (transition.type === "NONE") return;
  if ((transition.type !== "DISSOLVE" && transition.type !== "DIRECTIONAL" && transition.type !== "SMART_ANIMATE") || !Number.isFinite(transition.duration) || transition.duration < 0 || transition.duration > MAX_PROTOTYPE_DURATION_MS) throw runtimeError("INVALID_ARGUMENT");
  if (transition.type === "DIRECTIONAL" && !["LEFT", "RIGHT", "UP", "DOWN"].includes(transition.direction)) throw runtimeError("INVALID_ARGUMENT");
  if (transition.easing !== undefined && !["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT"].includes(transition.easing)) throw runtimeError("INVALID_ARGUMENT");
}

function validUrl(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
