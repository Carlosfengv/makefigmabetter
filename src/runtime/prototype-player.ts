import type { RuntimeProjection, RuntimeProjectionNode } from "./runtime-projection-store";
import type { DocumentSlideMetadata } from "../lib/editor-protocol";
import { RevisionLeasePool, type RevisionLease, type RevisionLeaseResource } from "./revision-lease";
import { runtimeError } from "./runtime-errors";
import {
  decodePrototypeMetadata,
  decodePrototypeReactions,
  type PrototypeAction,
  type PrototypeReaction,
  type PrototypeTransition,
  validatePrototypeMetadata,
  validatePrototypeReactions,
  PROTOTYPE_METADATA_EXTENSION,
  PROTOTYPE_REACTIONS_EXTENSION,
} from "./prototype-contract";
import { prototypeTransitionRenderPlan, type PrototypeTransitionRenderPlan, type TransitionViewport } from "./prototype-transition-compositor";
import { smartAnimateRenderPlan, type SmartAnimateRenderPlan } from "./smart-animate";
import { canChangeInstanceToVariant, instanceAncestor } from "./component-variant-state";

export type PrototypeInput = Readonly<{ type: "CLICK" | "PRESS" | "HOVER" | "ESC" | "OUTSIDE_CLICK" | "TAB" | "ACTIVATE"; targetId?: string; shiftKey?: boolean }>;
export type PrototypeOverlay = Readonly<{ frameId: string; position: "CENTER" | Readonly<{ x: number; y: number }>; dismissOnOutsideClick: boolean; previousFocusNodeId?: string }>;
export type PrototypePlayerState = Readonly<{
  sourceRevision: number;
  revisionLeaseId: string;
  currentFrameId: string;
  navigationHistory: readonly string[];
  overlays: readonly PrototypeOverlay[];
  focusNodeId?: string;
  loading?: Readonly<{ destinationId: string }>;
  stale: boolean;
  transition?: Readonly<{ fromFrameId: string; toFrameId: string; transition: PrototypeTransition; startedAtMs: number }>;
  componentVariants: readonly Readonly<{ instanceId: string; componentId: string }> [];
  componentTransition?: Readonly<{ instanceId: string; fromComponentId: string; toComponentId: string; transition: PrototypeTransition; startedAtMs: number }>;
  diagnostics: readonly Readonly<{ code: "TRANSITION_INTERRUPTED" | "TRANSITION_CANCELLED" | "VARIANT_TARGET_UNAVAILABLE"; atMs: number }> [];
  performance: Readonly<{ queuedInputs: number; completedInputs: number; lastInputMs: number; maxInputMs: number }>;
}>;

export type PrototypePlayerOptions = Readonly<{
  leasePool: RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>;
  prepareFrame?: (frameId: string, lease: RevisionLease<RuntimeProjection, RevisionLeaseResource>, signal: AbortSignal) => Promise<void>;
  openUrl?: (url: string) => Promise<void> | void;
  /** Renderer-owned same-lease hit testing. A Player never looks at the live
   * editor projection to decide which reaction receives an input. */
  hitTest?: (input: Readonly<{ x: number; y: number; currentFrameId: string }>, lease: RevisionLease<RuntimeProjection, RevisionLeaseResource>) => string | undefined;
  /** Renderer-owned focus order, scoped to the active frame or topmost
   * overlay. Returning no entries leaves focus on that scope's root. */
  focusableNodeIds?: (frameId: string, lease: RevisionLease<RuntimeProjection, RevisionLeaseResource>) => readonly string[];
  now?: () => number;
  reducedMotion?: boolean;
  onStateChange?: (state: PrototypePlayerState) => void;
}>;

/**
 * A single-threaded P0 player.  It only reads a RevisionLease's frozen
 * projection, so a later editor Snapshot cannot leak into an active preview.
 * Rendering/hit testing can consume `state` while this class owns deterministic
 * navigation, overlay, timer and focus semantics.
 */
export class PrototypePlayer {
  private lease: RevisionLease<RuntimeProjection, RevisionLeaseResource>;
  private readonly now: () => number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private currentFrameId: string;
  private navigationHistory: string[] = [];
  private overlays: PrototypeOverlay[] = [];
  private focusNodeId?: string;
  private loading?: { destinationId: string; controller: AbortController };
  private transition?: PrototypePlayerState["transition"];
  private readonly componentVariants = new Map<string, string>();
  private componentTransition?: NonNullable<PrototypePlayerState["componentTransition"]>;
  private diagnostics: Array<NonNullable<PrototypePlayerState["diagnostics"]>[number]> = [];
  private queuedInputs = 0;
  private completedInputs = 0;
  private lastInputMs = 0;
  private maxInputMs = 0;
  private stale = false;
  private closed = false;
  private queue = Promise.resolve();

  constructor(private readonly options: PrototypePlayerOptions, projection: RuntimeProjection, startFrameId?: string) {
    this.now = options.now ?? Date.now;
    this.lease = options.leasePool.acquire({ revision: projection.revision, projection, resources: resourcesFor(projection) });
    this.currentFrameId = startFrameId ?? startingFrameId(this.lease.projection);
    if (!frameFor(this.lease.projection, this.currentFrameId)) {
      options.leasePool.release(this.lease.id);
      throw runtimeError("NODE_NOT_FOUND", { nodeId: this.currentFrameId });
    }
    this.focusFirst(this.currentFrameId);
    this.armTimeouts();
    this.emit();
  }

  get state(): PrototypePlayerState {
    this.assertOpen();
    this.options.leasePool.get(this.lease.id);
    return Object.freeze({
      sourceRevision: this.lease.revision,
      revisionLeaseId: this.lease.id,
      currentFrameId: this.currentFrameId,
      navigationHistory: Object.freeze([...this.navigationHistory]),
      overlays: Object.freeze(this.overlays.map((overlay) => Object.freeze({ ...overlay }))),
      ...(this.focusNodeId ? { focusNodeId: this.focusNodeId } : {}),
      ...(this.loading ? { loading: { destinationId: this.loading.destinationId } } : {}),
      stale: this.stale,
      ...(this.transition ? { transition: this.transition } : {}),
      componentVariants: Object.freeze([...this.componentVariants.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([instanceId, componentId]) => Object.freeze({ instanceId, componentId }))),
      ...(this.componentTransition ? { componentTransition: this.componentTransition } : {}),
      diagnostics: Object.freeze(this.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
      performance: Object.freeze({ queuedInputs: this.queuedInputs, completedInputs: this.completedInputs, lastInputMs: this.lastInputMs, maxInputMs: this.maxInputMs }),
    });
  }

  /** Call from a newer editor fence.  The preview remains on its leased input
   * and surfaces a non-blocking restart state instead of mixing revisions. */
  notifyEditorRevision(revision: number): void {
    this.assertOpen();
    if (revision > this.lease.revision) { this.stale = true; this.emit(); }
  }

  dispatch(input: PrototypeInput): Promise<void> {
    return this.enqueue(async () => {
      if (input.type === "ESC") { this.closeOverlay(); return; }
      if (input.type === "TAB") { this.moveFocus(input.shiftKey === true); return; }
      if (input.type === "ACTIVATE") {
        if (this.focusNodeId) await this.dispatchActivation(this.focusNodeId);
        return;
      }
      if (input.type === "OUTSIDE_CLICK") {
        const top = this.overlays.at(-1);
        if (top?.dismissOnOutsideClick) this.closeOverlay();
        return;
      }
      const target = input.targetId ? nodeFor(this.lease.projection, input.targetId) : undefined;
      if (!target || target.visible === false) return;
      let handled = false;
      for (const node of interactionPath(this.lease.projection, target)) {
        const reactions = reactionsFor(node).filter((reaction) => matchesTrigger(reaction, input.type));
        for (const reaction of reactions) {
          handled = true;
          const navigated = await this.runReaction(reaction, target.id);
          if (navigated) return;
        }
      }
      if (!handled && input.type === "CLICK" && slideTiming(this.currentSlide())?.type === "ON_CLICK") {
        await this.navigateSlide(1);
      }
    });
  }

  dispatchPointer(input: Readonly<{ type: "CLICK" | "PRESS" | "HOVER"; x: number; y: number }>): Promise<void> {
    this.assertOpen();
    if (!this.options.hitTest) throw runtimeError("UNSUPPORTED_FEATURE");
    const targetId = this.options.hitTest({ x: input.x, y: input.y, currentFrameId: this.currentFrameId }, this.options.leasePool.get(this.lease.id));
    return this.dispatch({ type: input.type, targetId });
  }

  /** A host should call this for Enter/Space/Tab after applying its platform
   * key normalization. Every resulting action still flows through the same
   * serialized queue as pointer and timer input. */
  dispatchKeyboard(input: Readonly<{ key: "ENTER" | "SPACE" | "TAB" | "ARROW_LEFT" | "ARROW_RIGHT" | "PAGE_UP" | "PAGE_DOWN"; shiftKey?: boolean }>): Promise<void> {
    if (input.key === "ARROW_LEFT" || input.key === "PAGE_UP") return this.previousSlide();
    if (input.key === "ARROW_RIGHT" || input.key === "PAGE_DOWN" || (input.key === "SPACE" && this.currentSlide())) return this.nextSlide();
    return this.dispatch(input.key === "TAB" ? { type: "TAB", shiftKey: input.shiftKey } : { type: "ACTIVATE" });
  }

  /** Slides extension: advances inside the current SlideGrid's frozen order,
   * omitting authored skipped slides and stopping at the last playable slide. */
  nextSlide(): Promise<void> { return this.enqueue(() => this.navigateSlide(1)); }

  /** Slides extension: moves backward inside the same frozen SlideGrid. */
  previousSlide(): Promise<void> { return this.enqueue(() => this.navigateSlide(-1)); }

  /** Rendering owns the surfaces; it asks this deterministic state machine for
   * the current interpolation point. Expired transitions remain semantically
   * complete even if no paint frame was requested at exactly that millisecond. */
  transitionProgress(): number {
    const transition = this.state.transition;
    if (!transition || transition.transition.type === "NONE") return 1;
    const duration = transition.transition.duration;
    return duration <= 0 ? 1 : Math.min(1, Math.max(0, (this.now() - transition.startedAtMs) / duration));
  }

  /** A renderer consumes this plan to composite two frozen frame surfaces. */
  transitionRenderPlan(viewport: TransitionViewport): PrototypeTransitionRenderPlan {
    return prototypeTransitionRenderPlan(this.state.transition?.transition, this.transitionProgress(), viewport);
  }

  /** M5's layer-level plan shares this Player's frozen lease and timing with
   * the transition compositor. Undefined tells the host to use its ordinary
   * two-surface plan. */
  smartAnimateRenderPlan(): SmartAnimateRenderPlan | undefined {
    const transition = this.state.transition;
    if (!transition || transition.transition.type !== "SMART_ANIMATE") return undefined;
    return smartAnimateRenderPlan(this.lease.projection, transition.fromFrameId, transition.toFrameId, this.transitionProgress());
  }

  /** M5's variant equivalent: the renderer may render the two Component
   * subtrees through this plan while its host applies the selected instance
   * state. It reads no live component document state. */
  componentSmartAnimateRenderPlan(): SmartAnimateRenderPlan | undefined {
    const transition = this.componentTransition;
    if (!transition || transition.transition.type !== "SMART_ANIMATE") return undefined;
    return smartAnimateRenderPlan(this.lease.projection, transition.fromComponentId, transition.toComponentId, this.componentTransitionProgress());
  }

  /** Explicit host cancellation is deterministic: preserve the logical
   * destination and remove only the transient animation. */
  cancelTransition(): void {
    this.assertOpen();
    if (!this.transition && !this.componentTransition) return;
    this.transition = undefined; this.componentTransition = undefined;
    this.recordDiagnostic("TRANSITION_CANCELLED"); this.emit();
  }

  restartFromLatest(projection: RuntimeProjection, startFrameId?: string): void {
    this.assertOpen();
    this.cancelLoading(); this.clearTimers();
    this.options.leasePool.release(this.lease.id);
    this.lease = this.options.leasePool.acquire({ revision: projection.revision, projection, resources: resourcesFor(projection) });
    this.currentFrameId = startFrameId ?? startingFrameId(projection);
    if (!frameFor(projection, this.currentFrameId)) throw runtimeError("NODE_NOT_FOUND", { nodeId: this.currentFrameId });
    this.navigationHistory = []; this.overlays = []; this.focusNodeId = undefined; this.transition = undefined; this.componentTransition = undefined; this.componentVariants.clear(); this.diagnostics = []; this.queuedInputs = 0; this.completedInputs = 0; this.lastInputMs = 0; this.maxInputMs = 0; this.stale = false;
    this.armTimeouts(); this.emit();
  }

  close(): void {
    if (this.closed) return;
    this.cancelLoading(); this.clearTimers(); this.options.leasePool.release(this.lease.id); this.closed = true;
  }

  private async runReaction(reaction: PrototypeReaction, sourceId: string): Promise<boolean> {
    for (const action of reaction.actions) {
      if (await this.runAction(action, sourceId)) return true;
    }
    return false;
  }

  private async runAction(action: PrototypeAction, sourceId: string): Promise<boolean> {
    if (action.type === "URL") {
      if (!this.options.openUrl) throw runtimeError("PERMISSION_DENIED");
      await this.options.openUrl(action.url);
      return false;
    }
    if (action.type === "BACK") { this.back(); return true; }
    if (action.type === "CLOSE") { this.closeOverlay(); return true; }
    if (action.type === "CHANGE_TO") return this.changeToVariant(action, sourceId);
    if (action.type !== "NODE") return false;
    const destination = action.destinationId ? frameFor(this.lease.projection, action.destinationId) : undefined;
    if (!destination) return false;
    await this.prepare(destination.id);
    if (action.navigation === "OVERLAY") {
      const metadata = metadataFor(destination);
      const relative = action.overlayRelativePosition ?? metadata?.overlay?.relativePosition;
      this.overlays.push({
        frameId: destination.id,
        position: metadata?.overlay?.positionType === "MANUAL" && relative ? relative : "CENTER",
        dismissOnOutsideClick: metadata?.overlay?.backgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE",
        previousFocusNodeId: sourceId,
      });
      this.focusFirst(destination.id);
      this.startTransition(this.currentFrameId, destination.id, action.transition);
      this.emit();
      return true;
    }
    this.navigationHistory.push(this.currentFrameId);
    const from = this.currentFrameId;
    this.currentFrameId = destination.id;
    this.overlays = [];
    this.focusFirst(destination.id);
    this.startTransition(from, destination.id, action.transition);
    this.armTimeouts(); this.emit();
    return true;
  }

  private async prepare(frameId: string): Promise<void> {
    if (!this.options.prepareFrame) return;
    this.cancelLoading();
    const controller = new AbortController();
    this.loading = { destinationId: frameId, controller }; this.emit();
    try { await this.options.prepareFrame(frameId, this.options.leasePool.get(this.lease.id), controller.signal); }
    finally { if (this.loading?.controller === controller) { this.loading = undefined; this.emit(); } }
  }

  private back(): void {
    if (this.overlays.length) { this.closeOverlay(); return; }
    const previous = this.navigationHistory.pop();
    if (!previous) return;
    const from = this.currentFrameId; this.currentFrameId = previous; this.focusNodeId = previous; this.startTransition(from, previous, { type: "NONE" }); this.armTimeouts(); this.emit();
  }

  private closeOverlay(): void {
    const overlay = this.overlays.pop();
    if (!overlay) return;
    this.focusNodeId = overlay.previousFocusNodeId ?? this.currentFrameId;
    this.transition = undefined; this.emit();
  }

  private currentSlide(): RuntimeProjectionNode | undefined {
    const node = frameFor(this.lease.projection, this.currentFrameId);
    return node?.type === "SLIDE" ? node : undefined;
  }

  private async navigateSlide(step: -1 | 1): Promise<void> {
    const current = this.currentSlide();
    if (!current) return;
    const slides = playableSlidesFor(this.lease.projection, current.id);
    const index = slides.findIndex((slide) => slide.id === current.id);
    const destination = index >= 0 ? slides[index + step] : undefined;
    if (!destination) return;
    await this.prepare(destination.id);
    const from = current.id;
    if (step > 0) this.navigationHistory.push(from);
    else if (this.navigationHistory.at(-1) === destination.id) this.navigationHistory.pop();
    this.currentFrameId = destination.id;
    this.overlays = [];
    this.focusFirst(destination.id);
    this.startTransition(from, destination.id, step > 0 ? slideTransition(current) : { type: "NONE" });
    this.armTimeouts();
    this.emit();
  }

  private async dispatchActivation(targetId: string): Promise<void> {
    const target = nodeFor(this.lease.projection, targetId);
    if (!target || target.visible === false) return;
    for (const node of interactionPath(this.lease.projection, target)) {
      for (const reaction of reactionsFor(node).filter((reaction) => matchesTrigger(reaction, "CLICK"))) {
        if (await this.runReaction(reaction, target.id)) return;
      }
    }
  }

  private moveFocus(reverse: boolean): void {
    const scopeId = this.overlays.at(-1)?.frameId ?? this.currentFrameId;
    const focusable = this.focusableIds(scopeId);
    if (!focusable.length) { this.focusNodeId = scopeId; this.emit(); return; }
    const currentIndex = this.focusNodeId ? focusable.indexOf(this.focusNodeId) : -1;
    const nextIndex = reverse
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    this.focusNodeId = focusable[nextIndex]; this.emit();
  }

  private focusFirst(scopeId: string): void { this.focusNodeId = this.focusableIds(scopeId)[0] ?? scopeId; }
  private focusableIds(scopeId: string): readonly string[] {
    const candidates = this.options.focusableNodeIds?.(scopeId, this.options.leasePool.get(this.lease.id)) ?? [];
    return candidates.filter((id) => isDescendantOf(this.lease.projection, id, scopeId));
  }

  private armTimeouts(): void {
    this.clearTimers();
    for (const node of frameSubtree(this.lease.projection, this.currentFrameId)) {
      reactionsFor(node).forEach((reaction, reactionIndex) => {
        if (reaction.trigger.type !== "AFTER_TIMEOUT") return;
        const id = `${node.id}:${reactionIndex}`;
        this.timers.set(id, setTimeout(() => { void this.enqueue(async () => { await this.runReaction(reaction, node.id); }); }, reaction.trigger.timeout));
      });
    }
    const slide = this.currentSlide();
    const timing = slideTiming(slide);
    if (slide && timing?.type === "AFTER_DELAY") {
      const timeout = Math.max(0, timing.delay ?? 0) * 1_000;
      this.timers.set("slide:auto-advance", setTimeout(() => {
        void this.enqueue(() => this.navigateSlide(1));
      }, timeout));
    }
  }

  private startTransition(fromFrameId: string, toFrameId: string, transition: PrototypeTransition | null | undefined): void {
    if (this.transition && this.transitionProgress() < 1) this.recordDiagnostic("TRANSITION_INTERRUPTED");
    const chosen = this.options.reducedMotion || !transition ? { type: "NONE" } as const : transition;
    this.transition = chosen.type === "NONE" ? undefined : { fromFrameId, toFrameId, transition: chosen, startedAtMs: this.now() };
  }

  private changeToVariant(action: Extract<PrototypeAction, { type: "CHANGE_TO" }>, sourceId: string): boolean {
    const instance = instanceAncestor(this.lease.projection, sourceId);
    const destinationId = action.destinationId ?? undefined;
    if (!instance || !destinationId || !canChangeInstanceToVariant(this.lease.projection, instance.id, destinationId)) {
      this.recordDiagnostic("VARIANT_TARGET_UNAVAILABLE"); this.emit(); return false;
    }
    const fromComponentId = this.componentVariants.get(instance.id)
      ?? ((instance.instanceMetadata as { mainComponentId?: string } | undefined)?.mainComponentId);
    if (!fromComponentId) { this.recordDiagnostic("VARIANT_TARGET_UNAVAILABLE"); this.emit(); return false; }
    if (this.componentTransition && this.componentTransitionProgress() < 1) this.recordDiagnostic("TRANSITION_INTERRUPTED");
    this.componentVariants.set(instance.id, destinationId);
    const transition = this.options.reducedMotion || !action.transition ? { type: "NONE" } as const : action.transition;
    this.componentTransition = transition.type === "NONE" ? undefined : { instanceId: instance.id, fromComponentId, toComponentId: destinationId, transition, startedAtMs: this.now() };
    this.emit();
    return true;
  }

  private componentTransitionProgress(): number {
    const transition = this.componentTransition;
    if (!transition || transition.transition.type === "NONE") return 1;
    const duration = transition.transition.duration;
    return duration <= 0 ? 1 : Math.min(1, Math.max(0, (this.now() - transition.startedAtMs) / duration));
  }

  private enqueue(operation: () => Promise<void> | void): Promise<void> {
    this.assertOpen();
    this.queuedInputs += 1;
    this.emit();
    const run = async () => {
      const startedAtMs = this.now();
      try {
        this.assertOpen(); this.options.leasePool.get(this.lease.id); await operation();
      } finally {
        const elapsedMs = Math.max(0, this.now() - startedAtMs);
        this.queuedInputs -= 1;
        this.completedInputs += 1;
        this.lastInputMs = elapsedMs;
        this.maxInputMs = Math.max(this.maxInputMs, elapsedMs);
        this.emit();
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private cancelLoading(): void { this.loading?.controller.abort(); this.loading = undefined; }
  private clearTimers(): void { this.timers.forEach((timer) => clearTimeout(timer)); this.timers.clear(); }
  private assertOpen(): void { if (this.closed) throw runtimeError("RUNTIME_CLOSED"); }
  private recordDiagnostic(code: NonNullable<PrototypePlayerState["diagnostics"]>[number]["code"]): void {
    this.diagnostics = [...this.diagnostics, { code, atMs: this.now() }].slice(-32);
  }
  private emit(): void { if (!this.closed) this.options.onStateChange?.(this.state); }
}

function resourcesFor(projection: RuntimeProjection): RevisionLeaseResource[] {
  const root = projection.nodes.find((node) => node.type === "DOCUMENT");
  const assets = Array.isArray(root?.assets) ? root.assets : [];
  return assets.flatMap((asset): RevisionLeaseResource[] => asset && typeof asset === "object" && typeof (asset as { assetId?: unknown }).assetId === "string" && typeof (asset as { contentHash?: unknown }).contentHash === "string" && typeof (asset as { byteLength?: unknown }).byteLength === "number"
    ? [{ id: (asset as { assetId: string }).assetId, contentHash: (asset as { contentHash: string }).contentHash, byteLength: (asset as { byteLength: number }).byteLength }]
    : []);
}
function nodeFor(projection: RuntimeProjection, id: string): RuntimeProjectionNode | undefined { return projection.nodes.find((node) => node.id === id && node.removed !== true); }
function frameFor(projection: RuntimeProjection, id: string): RuntimeProjectionNode | undefined { const node = nodeFor(projection, id); return node?.type === "FRAME" || (node?.type === "SLIDE" && slideMetadataFor(node)?.isSkippedSlide !== true) ? node : undefined; }
function startingFrameId(projection: RuntimeProjection): string {
  const frames = projection.nodes.filter((node) => node.removed !== true && frameFor(projection, node.id));
  const explicit = frames.find((node) => metadataFor(node)?.startingPoint === true);
  const frame = explicit ?? frames[0];
  if (!frame) throw runtimeError("NODE_NOT_FOUND");
  return frame.id;
}
function reactionsFor(node: RuntimeProjectionNode): readonly PrototypeReaction[] {
  const extension = (node.extensions as Record<string, unknown> | undefined)?.[PROTOTYPE_REACTIONS_EXTENSION];
  if (extension !== undefined) return decodePrototypeReactions(extension);
  try { return validatePrototypeReactions(node.reactions as PrototypeReaction[]); } catch { return []; }
}
function metadataFor(node: RuntimeProjectionNode) {
  const extension = (node.extensions as Record<string, unknown> | undefined)?.[PROTOTYPE_METADATA_EXTENSION];
  if (extension !== undefined) return decodePrototypeMetadata(extension);
  try { return validatePrototypeMetadata(node.prototypeMetadata as Parameters<typeof validatePrototypeMetadata>[0]); } catch { return undefined; }
}
function interactionPath(projection: RuntimeProjection, target: RuntimeProjectionNode): RuntimeProjectionNode[] { const result: RuntimeProjectionNode[] = []; const seen = new Set<string>(); let current: RuntimeProjectionNode | undefined = target; while (current && !seen.has(current.id)) { result.push(current); seen.add(current.id); current = typeof current.parentId === "string" ? nodeFor(projection, current.parentId) : undefined; } return result; }
function frameSubtree(projection: RuntimeProjection, frameId: string): RuntimeProjectionNode[] { const result: RuntimeProjectionNode[] = []; const visit = (id: string) => { const node = nodeFor(projection, id); if (!node) return; result.push(node); projection.nodes.filter((candidate) => candidate.parentId === id && candidate.removed !== true).forEach((child) => visit(child.id)); }; visit(frameId); return result; }
function isDescendantOf(projection: RuntimeProjection, nodeId: string, ancestorId: string): boolean { let current = nodeFor(projection, nodeId); const seen = new Set<string>(); while (current && !seen.has(current.id)) { if (current.id === ancestorId) return true; seen.add(current.id); current = typeof current.parentId === "string" ? nodeFor(projection, current.parentId) : undefined; } return false; }
function playableSlidesFor(projection: RuntimeProjection, currentSlideId: string): RuntimeProjectionNode[] {
  const current = nodeFor(projection, currentSlideId);
  const row = current?.parentId ? nodeFor(projection, current.parentId) : undefined;
  const grid = row?.type === "SLIDE_ROW" && row.parentId ? nodeFor(projection, row.parentId) : undefined;
  if (current?.type !== "SLIDE" || grid?.type !== "SLIDE_GRID") return [];
  const orderedRows = projection.nodes
    .filter((node) => node.removed !== true && node.type === "SLIDE_ROW" && node.parentId === grid.id)
    .sort(comparePresentationSiblings);
  return orderedRows.flatMap((candidateRow) => projection.nodes
    .filter((node) => node.removed !== true && node.type === "SLIDE" && node.parentId === candidateRow.id && slideMetadataFor(node)?.isSkippedSlide !== true)
    .sort(comparePresentationSiblings));
}
function comparePresentationSiblings(left: RuntimeProjectionNode, right: RuntimeProjectionNode): number {
  const leftIndex = typeof left.siblingIndex === "number" && Number.isSafeInteger(left.siblingIndex) ? left.siblingIndex : Number.MAX_SAFE_INTEGER;
  const rightIndex = typeof right.siblingIndex === "number" && Number.isSafeInteger(right.siblingIndex) ? right.siblingIndex : Number.MAX_SAFE_INTEGER;
  return leftIndex - rightIndex || left.id.localeCompare(right.id);
}
function slideMetadataFor(slide: RuntimeProjectionNode | undefined): DocumentSlideMetadata | undefined {
  const metadata = slide?.slideMetadata;
  if (slide?.type !== "SLIDE" || !metadata || typeof metadata !== "object") return undefined;
  const value = metadata as Record<string, unknown>;
  const transition = value.transition;
  if (typeof value.isSkippedSlide !== "boolean" || !transition || typeof transition !== "object") return undefined;
  const record = transition as Record<string, unknown>;
  const timing = record.timing;
  if (typeof record.style !== "string" || typeof record.curve !== "string"
    || !SLIDE_TRANSITION_STYLES.has(record.style as DocumentSlideMetadata["transition"]["style"])
    || !SLIDE_TRANSITION_CURVES.has(record.curve as DocumentSlideMetadata["transition"]["curve"])
    || typeof record.duration !== "number" || !Number.isFinite(record.duration) || record.duration < 0 || record.duration > 60
    || !timing || typeof timing !== "object") return undefined;
  const timingRecord = timing as Record<string, unknown>;
  if (timingRecord.type !== "ON_CLICK" && (timingRecord.type !== "AFTER_DELAY"
    || typeof timingRecord.delay !== "number" || !Number.isFinite(timingRecord.delay)
    || timingRecord.delay < 0 || timingRecord.delay > 60)) return undefined;
  return metadata as DocumentSlideMetadata;
}
function slideTiming(slide: RuntimeProjectionNode | undefined): DocumentSlideMetadata["transition"]["timing"] | undefined {
  return slideMetadataFor(slide)?.transition.timing;
}
function slideTransition(slide: RuntimeProjectionNode): PrototypeTransition {
  const transition = slideMetadataFor(slide)?.transition;
  if (!transition || transition.style === "NONE") return { type: "NONE" };
  const duration = transition.duration * 1_000;
  const easing = slideTransitionEasing(transition.curve);
  if (transition.style === "DISSOLVE") return { type: "DISSOLVE", duration, easing };
  if (transition.style === "SMART_ANIMATE") return { type: "SMART_ANIMATE", duration, easing };
  const direction = transition.style.includes("LEFT") ? "LEFT"
    : transition.style.includes("RIGHT") ? "RIGHT"
      : transition.style.includes("TOP") ? "UP"
        : "DOWN";
  return { type: "DIRECTIONAL", direction, duration, easing };
}
function slideTransitionEasing(curve: DocumentSlideMetadata["transition"]["curve"]): "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" {
  if (curve === "LINEAR" || curve === "EASE_IN" || curve === "EASE_OUT" || curve === "EASE_IN_AND_OUT") return curve;
  return "EASE_IN_AND_OUT";
}
const SLIDE_TRANSITION_STYLES = new Set<DocumentSlideMetadata["transition"]["style"]>([
  "NONE", "DISSOLVE", "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_BOTTOM", "SLIDE_FROM_TOP",
  "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_BOTTOM", "PUSH_FROM_TOP", "MOVE_FROM_LEFT",
  "MOVE_FROM_RIGHT", "MOVE_FROM_TOP", "MOVE_FROM_BOTTOM", "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT",
  "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM", "MOVE_OUT_TO_LEFT", "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP",
  "MOVE_OUT_TO_BOTTOM", "SMART_ANIMATE",
]);
const SLIDE_TRANSITION_CURVES = new Set<DocumentSlideMetadata["transition"]["curve"]>([
  "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "GENTLE", "QUICK", "BOUNCY", "SLOW",
]);
function matchesTrigger(reaction: PrototypeReaction, input: PrototypeInput["type"]): boolean { return (input === "CLICK" && reaction.trigger.type === "ON_CLICK") || (input === "PRESS" && reaction.trigger.type === "ON_PRESS") || (input === "HOVER" && reaction.trigger.type === "ON_HOVER"); }
