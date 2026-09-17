"use client";

import { useEffect, useRef, useState } from "react";
import type {
  DocumentTransformModifier,
  EditorSnapshot,
  MainToWorker,
  WorkerToMain,
} from "@/lib/editor-protocol";
import { createNode } from "@/lib/editor-protocol";
import { NORMAL_BLEND_ISOLATION_EXTENSION } from "@/lib/node-blend-semantics";
import { resolveMultiResizeSelection } from "@/lib/multi-selection";
import { transformGroupRepeatMatrices, transformGroupRepeatWorldBounds } from "@/lib/transform-group-repeat";
import { transformPoint, worldTransformForNode } from "@/lib/scene-transform";
import { FigmaCompatibleRuntime } from "@/runtime/figma-compatible-runtime";
import { RuntimeSession } from "@/runtime/runtime-session";
import { isRuntimeError } from "@/runtime/runtime-errors";
import {
  RuntimeWorkerBridge,
  runtimeProjectionFromEditorSnapshot,
} from "@/runtime/runtime-worker-bridge";
import { createApiPrototypeCardFlow } from "@/runtime/api-prototype-card-flow";
import { createPhase2ProfessionalCompositeFixture } from "@/lib/phase2-professional-composite-fixture";
import type { PrototypePlayerState } from "@/runtime/prototype-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type HarnessState =
  | "booting"
  | "worker-ready"
  | "waiting-for-runtime"
  | "running"
  | "passed"
  | "failed";
type SnapshotWaiter = {
  predicate: (snapshot: EditorSnapshot) => boolean;
  resolve: (snapshot: EditorSnapshot) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};
type ViewStateMessage = Extract<WorkerToMain, { type: "view-state" }>;
type ViewStateWaiter = {
  predicate: (message: ViewStateMessage) => boolean;
  resolve: (message: ViewStateMessage) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};
type FrameHashMessage = Extract<WorkerToMain, { type: "frame-hash" }>;
type FrameHashWaiter = {
  predicate: (message: FrameHashMessage) => boolean;
  resolve: (message: FrameHashMessage) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};
type ProjectionBenchmarkResult = Readonly<{
  nodeCount: number;
  projectedNodeCount: number;
  groups: readonly Readonly<{
    samplesMs: readonly number[];
    p50Ms: number;
    p95Ms: number;
  }>[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}>;

const PF01_NODE_COUNTS = [1_000, 5_000, 10_000, 100_000] as const;

/** Development-only acceptance harness. It is intentionally a button/DOM
 * surface rather than a hidden test hook so the real Worker transaction path
 * can be exercised from a browser without exposing a production global API. */
export function RuntimeM1Harness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<FigmaCompatibleRuntime | null>(null);
  const bridgeRef = useRef<RuntimeWorkerBridge | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const latestSnapshotRef = useRef<EditorSnapshot | null>(null);
  const snapshotWaiterRef = useRef<SnapshotWaiter | null>(null);
  const viewStateWaiterRef = useRef<ViewStateWaiter | null>(null);
  const latestFrameHashRef = useRef<FrameHashMessage | null>(null);
  const frameHashWaiterRef = useRef<FrameHashWaiter | null>(null);
  const [state, setState] = useState<HarnessState>("booting");
  const [lines, setLines] = useState<string[]>([]);
  const [playerDiagnostics, setPlayerDiagnostics] =
    useState<PrototypePlayerState | null>(null);
  const [projectionBenchmark, setProjectionBenchmark] = useState<
    readonly ProjectionBenchmarkResult[]
  >([]);

  const append = (line: string) => setLines((current) => [...current, line]);

  const waitForSnapshot = (
    predicate: SnapshotWaiter["predicate"],
    description: string,
  ) =>
    new Promise<EditorSnapshot>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (snapshotWaiterRef.current?.timeoutId === timeoutId)
          snapshotWaiterRef.current = null;
        reject(new Error(`Timed out waiting for ${description}.`));
      }, 10_000);
      snapshotWaiterRef.current = { predicate, resolve, reject, timeoutId };
    });

  const waitForViewState = (
    predicate: ViewStateWaiter["predicate"],
    description: string,
  ) => new Promise<ViewStateMessage>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (viewStateWaiterRef.current?.timeoutId === timeoutId)
        viewStateWaiterRef.current = null;
      reject(new Error(`Timed out waiting for ${description}.`));
    }, 10_000);
    viewStateWaiterRef.current = { predicate, resolve, reject, timeoutId };
  });

  const waitForFrameHash = (
    predicate: FrameHashWaiter["predicate"],
    description: string,
  ) => {
    const current = latestFrameHashRef.current;
    if (current && predicate(current)) return Promise.resolve(current);
    return new Promise<FrameHashMessage>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (frameHashWaiterRef.current?.timeoutId === timeoutId)
          frameHashWaiterRef.current = null;
        reject(new Error(`Timed out waiting for ${description}.`));
      }, 10_000);
      frameHashWaiterRef.current = { predicate, resolve, reject, timeoutId };
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !("transferControlToOffscreen" in canvas)) {
      setState("failed");
      append("OffscreenCanvas is unavailable in this browser.");
      return;
    }
    const worker = new Worker(
      new URL("../../workers/editor.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    const bridge = new RuntimeWorkerBridge((message) =>
      worker.postMessage(message),
    );
    bridgeRef.current = bridge;
    let disposed = false;
    worker.onmessage = ({ data }: MessageEvent<WorkerToMain>) => {
      bridge.observe(data);
      if (data.type === "ready") {
        setState("worker-ready");
        append("Worker ready; waiting for Canonical projection.");
        return;
      }
      if (data.type === "error") {
        const waiter = snapshotWaiterRef.current;
        if (waiter) {
          window.clearTimeout(waiter.timeoutId);
          snapshotWaiterRef.current = null;
          waiter.reject(new Error(`Worker error: ${data.code}`));
        }
        setState("failed");
        append(`Worker error: ${data.code}`);
        return;
      }
      if (data.type === "view-state") {
        const waiter = viewStateWaiterRef.current;
        if (waiter?.predicate(data)) {
          window.clearTimeout(waiter.timeoutId);
          viewStateWaiterRef.current = null;
          waiter.resolve(data);
        }
        return;
      }
      if (data.type === "frame-hash") {
        latestFrameHashRef.current = data;
        const waiter = frameHashWaiterRef.current;
        if (waiter?.predicate(data)) {
          window.clearTimeout(waiter.timeoutId);
          frameHashWaiterRef.current = null;
          waiter.resolve(data);
        }
        return;
      }
      if (data.type !== "snapshot") return;
      latestSnapshotRef.current = data.snapshot;
      append(`Projection received: ${data.snapshot.documentCore}.`);
      if (data.snapshot.documentCore === "TypeScript document prototype") {
        const fallback = data.snapshot.diagnostics?.recent.find(
          (event) => event.code === "WASM_BRIDGE_FALLBACK",
        );
        setState("failed");
        append(
          `Canonical Worker unavailable: ${String(fallback?.details?.errorKind ?? "unknown")}.`,
        );
        return;
      }
      if (
        !runtimeRef.current &&
        data.snapshot.documentCore === "Rust/WASM bridge ready"
      ) {
        runtimeRef.current = new FigmaCompatibleRuntime(
          new RuntimeSession({
            sessionId: `runtime-harness:${data.snapshot.documentId}`,
            projection: runtimeProjectionFromEditorSnapshot(data.snapshot),
            currentPageId: data.snapshot.activePageId,
            transport: bridge,
            onError: (error) => {
              setState("failed");
              append(error instanceof Error ? error.message : "Runtime error");
            },
          }),
        );
        setState("waiting-for-runtime");
        append(`Runtime ready at revision ${data.snapshot.revision}.`);
      } else if (runtimeRef.current && !bridge.hasPendingTransactions) {
        runtimeRef.current.session.applyConfirmedProjection(
          runtimeProjectionFromEditorSnapshot(data.snapshot),
        );
      }
      const waiter = snapshotWaiterRef.current;
      if (waiter?.predicate(data.snapshot)) {
        window.clearTimeout(waiter.timeoutId);
        snapshotWaiterRef.current = null;
        waiter.resolve(data.snapshot);
      }
    };
    worker.onerror = () => {
      if (!disposed) {
        setState("failed");
        append("Worker crashed.");
      }
    };
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: 1,
        height: 1,
        dpr: 1,
        documentId: "00000000-0000-0000-0000-000000000002",
        rendererPreference: "canvas2d",
        simulateGpuLosses: 0,
        simulateGpuLossAfterImage: false,
        captureFrameHash: true,
        captureFrameSamples: [
          { label: "repeat-mask-inside", x: 380, y: 280 },
          { label: "repeat-mask-outside", x: 450, y: 280 },
          { label: "nested-repeat-mask-inside", x: 370, y: 530 },
          { label: "nested-repeat-mask-outside", x: 430, y: 530 },
          { label: "repeat-effect-source-inside", x: 80, y: 130 },
          { label: "repeat-effect-inside", x: 380, y: 130 },
          { label: "repeat-effect-blend-source", x: 80, y: 550 },
          { label: "repeat-effect-blend-derived", x: 380, y: 550 },
          { label: "repeat-linear-paint-source", x: 160, y: 550 },
          { label: "repeat-linear-paint-derived", x: 460, y: 550 },
          { label: "repeat-linear-node-source", x: 220, y: 550 },
          { label: "repeat-linear-node-derived", x: 520, y: 550 },
          { label: "repeat-offscreen-effect-derived", x: 140, y: 585 },
          { label: "repeat-offscreen-linear-derived", x: 240, y: 585 },
          { label: "repeat-background-blur-source", x: -180, y: 545 },
          { label: "repeat-background-blur-derived", x: 120, y: 545 },
          { label: "repeat-group-background-blur-source", x: -180, y: 580 },
          { label: "repeat-group-background-blur-derived", x: 120, y: 580 },
          { label: "repeat-radial-background-blur-source", x: -280, y: -425 },
          { label: "repeat-radial-background-blur-derived", x: -280, y: -305 },
          { label: "repeat-radial-background-blur-shadow-rotated", x: -280, y: -324 },
          { label: "repeat-radial-background-blur-shadow-unrotated-control", x: -280, y: -282 },
          { label: "repeat-prepared-background-blur-local-source", x: -480, y: 345 },
          { label: "repeat-prepared-background-blur-local-derived", x: -180, y: 345 },
          { label: "repeat-prepared-background-blur-external-source", x: -480, y: 400 },
          { label: "repeat-prepared-background-blur-external-derived", x: -180, y: 400 },
          { label: "repeat-mask-backdrop-blur-source", x: -480, y: 480 },
          { label: "repeat-mask-backdrop-blur-derived", x: -180, y: 480 },
          { label: "repeat-mask-backdrop-native-source", x: -480, y: 520 },
          { label: "repeat-mask-backdrop-native-derived", x: -180, y: 520 },
          { label: "repeat-mask-backdrop-linear-source", x: -480, y: 560 },
          { label: "repeat-mask-backdrop-linear-derived", x: -180, y: 560 },
          { label: "repeat-mask-backdrop-outside-source", x: -450, y: 520 },
          { label: "repeat-mask-backdrop-outside-derived", x: -150, y: 520 },
          { label: "repeat-radial-mask-backdrop-source", x: -280, y: -425 },
          { label: "repeat-radial-mask-backdrop-derived", x: -280, y: -305 },
          { label: "repeat-prepared-owner-normal-source", x: 200, y: -490 },
          { label: "repeat-prepared-owner-normal-derived", x: 460, y: -490 },
          { label: "repeat-prepared-owner-multiply-source", x: 200, y: -420 },
          { label: "repeat-prepared-owner-multiply-derived", x: 460, y: -420 },
          { label: "repeat-frame-mask-inside", x: 380, y: 520 },
          { label: "repeat-frame-mask-outside", x: 430, y: 520 },
          { label: "repeat-frame-mask-source-inside", x: 80, y: 520 },
          { label: "repeat-frame-mask-source-outside", x: 130, y: 520 },
          { label: "repeat-boolean-mask-inside", x: 350, y: 520 },
          { label: "repeat-boolean-mask-hole", x: 390, y: 520 },
          { label: "repeat-boolean-mask-source-inside", x: 50, y: 520 },
          { label: "repeat-boolean-mask-source-hole", x: 90, y: 520 },
        ],
      } satisfies MainToWorker,
      [offscreen],
    );
    return () => {
      disposed = true;
      bridge.close();
      bridgeRef.current = null;
      workerRef.current = null;
      const waiter = snapshotWaiterRef.current;
      if (waiter) {
        window.clearTimeout(waiter.timeoutId);
        waiter.reject(new Error("Runtime harness was disposed."));
      }
      snapshotWaiterRef.current = null;
      const viewStateWaiter = viewStateWaiterRef.current;
      if (viewStateWaiter) {
        window.clearTimeout(viewStateWaiter.timeoutId);
        viewStateWaiter.reject(new Error("Runtime harness was disposed."));
      }
      viewStateWaiterRef.current = null;
      latestSnapshotRef.current = null;
      runtimeRef.current = null;
      worker.terminate();
    };
  }, []);

  const runCardScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    setPlayerDiagnostics(null);
    try {
      const frame = runtime.createFrame();
      frame.name = "M1 card";
      frame.x = 48;
      frame.y = 64;
      frame.resize(320, 180);
      const rectangle = runtime.createRectangle();
      rectangle.name = "Card surface";
      rectangle.x = 16;
      rectangle.y = 16;
      rectangle.resize(288, 148);
      const text = runtime.createText();
      text.name = "Card title";
      text.x = 32;
      text.y = 32;
      frame.appendChild(rectangle);
      frame.appendChild(text);

      if (
        frame.x !== 48 ||
        rectangle.x !== 16 ||
        rectangle.y !== 16 ||
        text.x !== 32 ||
        text.y !== 32 ||
        rectangle.parent !== frame ||
        text.parent !== frame ||
        frame.children.map((node) => node.id).join(",") !==
          `${rectangle.id},${text.id}`
      ) {
        throw new Error("PendingProjection did not provide read-your-writes.");
      }
      append("PendingProjection assertions passed before Ack.");
      const revision = await runtime.commitAsync();
      const committedFrame = await runtime.getNodeByIdAsync(frame.id);
      if (
        !committedFrame ||
        committedFrame.x !== 48 ||
        committedFrame.name !== "M1 card"
      ) {
        throw new Error(
          "Ack + Projection fence did not preserve the created card.",
        );
      }
      append(`Ack + Projection fence passed at revision ${revision}.`);
      const committedChildren = frame.children;
      if (
        committedChildren.map((node) => node.id).join(",") !==
          `${rectangle.id},${text.id}` ||
        committedChildren[0]?.x !== 16 ||
        committedChildren[0]?.y !== 16 ||
        committedChildren[1]?.x !== 32 ||
        committedChildren[1]?.y !== 32
      ) {
        append(
          `Committed card data: ${committedChildren.map((node) => `${node.id}@${node.x},${node.y}`).join("; ")}.`,
        );
        throw new Error(
          "Ack + Projection fence changed the card's layer order or child geometry.",
        );
      }
      append(
        `Committed children: ${committedChildren.length}; layer order and child geometry preserved.`,
      );
      const clone = rectangle.clone();
      clone.name = "Card surface copy";
      frame.insertChild(0, clone);
      text.remove();
      if (frame.children.map((node) => node.id).join(",") !== `${clone.id},${rectangle.id}` || !text.removed) {
        throw new Error("Pending clone/reorder/delete lifecycle was inconsistent.");
      }
      const lifecycleRevision = await runtime.commitAsync();
      const committedLifecycleIds = frame.children.map((node) => node.id).join(",");
      if (committedLifecycleIds !== `${clone.id},${rectangle.id}` || !text.removed) {
        append(`Committed lifecycle data: children=${frame.children.map((node) => `${node.name}:${node.id}`).join(",")}; expectedClone=${clone.id}; expectedRectangle=${rectangle.id}; textRemoved=${text.removed}.`);
        throw new Error("Clone/reorder/delete did not survive its Ack + Projection fence.");
      }
      append(`Clone/reorder/delete fence passed at revision ${lifecycleRevision}.`);

      const lifecycleUndoPromise = waitForSnapshot(
        (snapshot) =>
          snapshot.revision > lifecycleRevision &&
          snapshot.nodes.some((node) => node.id === text.id) &&
          !snapshot.nodes.some((node) => node.id === clone.id),
        "clone/reorder/delete Undo projection",
      );
      worker.postMessage({
        type: "command",
        command: { type: "undo" },
      } satisfies MainToWorker);
      const lifecycleUndo = await lifecycleUndoPromise;
      const restoredText = await runtime.getNodeByIdAsync(text.id);
      if (!restoredText || restoredText === text || !text.removed || !clone.removed || rectangle.parent !== frame) {
        throw new Error("Undo did not restore a fresh deleted proxy generation and retire the clone.");
      }
      append(`Clone/delete Undo lifecycle passed at revision ${lifecycleUndo.revision}.`);

      const undoSnapshotPromise = waitForSnapshot(
        (snapshot) =>
          snapshot.revision > lifecycleUndo.revision &&
          !snapshot.nodes.some((node) => node.id === frame.id),
        "Undo projection",
      );
      worker.postMessage({
        type: "command",
        command: { type: "undo" },
      } satisfies MainToWorker);
      const undoSnapshot = await undoSnapshotPromise;
      if (
        undoSnapshot.nodes.some((node) => node.id === frame.id) ||
        (await runtime.getNodeByIdAsync(frame.id)) !== null ||
        !committedFrame.removed
      ) {
        throw new Error(
          "Undo did not retire the committed card and its proxy generation.",
        );
      }
      append(`Undo projection passed at revision ${undoSnapshot.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runComponentApiScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    const initialSnapshot = latestSnapshotRef.current;
    if (!runtime || !worker || !initialSnapshot) return;
    setState("running");
    setLines([]);
    try {
      const componentId = crypto.randomUUID();
      const instanceId = crypto.randomUUID();
      const component = {
        ...createNode("component", 24, 24),
        id: componentId,
        pageId: initialSnapshot.activePageId,
        name: "Runtime component",
        componentMetadata: {
          key: "runtime-component",
          remote: false,
          description: "Runtime acceptance component",
          descriptionMarkdown: "**Runtime acceptance component**",
          documentationLinks: [],
          componentPropertyDefinitions: {
            Enabled: { type: "BOOLEAN" as const, defaultValue: true },
          },
        },
      };
      const instance = {
        ...createNode("instance", 180, 24),
        id: instanceId,
        pageId: initialSnapshot.activePageId,
        name: "Runtime instance",
        instanceMetadata: {
          mainComponentId: componentId,
          scaleFactor: 1,
          componentProperties: { Enabled: false },
          overrides: [{ id: instanceId, overriddenFields: ["fill"] }],
          isExposedInstance: true,
        },
      };
      const importedSnapshotPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > initialSnapshot.revision && snapshot.nodes.some((node) => node.id === instanceId),
        "Component projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: initialSnapshot.revision,
          commands: [{ type: "create", node: component }, { type: "create", node: instance }],
        },
      } satisfies MainToWorker);
      await importedSnapshotPromise;

      const componentProxy = await runtime.getNodeByIdAsync(componentId);
      const instanceProxy = await runtime.getNodeByIdAsync(instanceId);
      if (
        !componentProxy ||
        !instanceProxy ||
        (await instanceProxy.getMainComponentAsync()) !== componentProxy ||
        (await componentProxy.getInstancesAsync())[0] !== instanceProxy ||
        instanceProxy.componentPropertyValues.Enabled !== false ||
        instanceProxy.overrides.length !== 1
      ) {
        throw new Error("Component relationship projection was not preserved.");
      }
      append("Component identity, properties, overrides and reverse lookup passed.");

      instanceProxy.removeOverrides();
      const revision = await runtime.commitAsync();
      if (Array.from(instanceProxy.overrides).length !== 0) throw new Error("Ack + Projection fence did not persist removeOverrides().");
      append(`removeOverrides Ack + Projection fence passed at revision ${revision}.`);

      const undoSnapshotPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > revision && snapshot.nodes.some((node) => node.id === instanceId),
        "Component override Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      await undoSnapshotPromise;
      if (instanceProxy.removed || instanceProxy.overrides.length !== 1) {
        throw new Error("Undo did not restore Instance overrides on the existing proxy generation.");
      }
      append("Undo restored Instance overrides without replacing its proxy identity.");
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown harness failure.");
    }
  };

  const runParametricGeometryScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const polygon = runtime.createPolygon();
      polygon.name = "Runtime octagon";
      polygon.x = 24;
      polygon.y = 24;
      polygon.pointCount = 8;
      const star = runtime.createStar();
      star.name = "Runtime seven point star";
      star.x = 160;
      star.y = 24;
      star.pointCount = 7;
      star.innerRadius = .35;
      const vector = runtime.createVector();
      vector.name = "Runtime self-intersecting vector";
      vector.x = 296;
      vector.y = 24;
      vector.vectorPaths = [{ windingRule: "EVENODD", data: "M 0 0 L 100 100 L 0 100 L 100 0 Z" }];
      vector.strokeWeight = 3;
      vector.strokeCap = "ROUND";
      vector.strokeJoin = "BEVEL";
      vector.strokeMiterLimit = 4;
      vector.dashPattern = [8, 4, 2];
      const openVector = runtime.createVector();
      openVector.name = "Runtime open cubic";
      openVector.x = 432;
      openVector.y = 24;
      openVector.vectorPaths = [{ windingRule: "NONE", data: "M 0 0 C 20 0 40 40 80 40" }];
      const line = runtime.createLine();
      line.name = "Runtime dashed arrow line";
      line.x = 568;
      line.y = 84;
      line.strokeWeight = 5;
      line.strokeCap = "ARROW_LINES";
      line.dashPattern = [12, 6];
      if (
        polygon.pointCount !== 8 || star.pointCount !== 7 || star.innerRadius !== .35
        || vector.vectorPaths[0]?.windingRule !== "EVENODD"
        || vector.strokeCap !== "ROUND" || vector.strokeJoin !== "BEVEL"
        || vector.strokeMiterLimit !== 4 || vector.dashPattern.length !== 6
        || openVector.vectorPaths[0]?.windingRule !== "NONE"
        || line.strokeCap !== "ARROW_LINES" || line.dashPattern.length !== 2
      ) {
        throw new Error("Geometry did not provide Figma-shaped read-your-writes before Ack.");
      }
      append("Parametric, open/self-intersecting path and stroke read-your-writes passed before Ack.");

      const revision = await runtime.commitAsync();
      const snapshot = latestSnapshotRef.current;
      const committedPolygon = snapshot?.nodes.find((node) => node.id === polygon.id);
      const committedStar = snapshot?.nodes.find((node) => node.id === star.id);
      const committedVector = snapshot?.nodes.find((node) => node.id === vector.id);
      const committedOpenVector = snapshot?.nodes.find((node) => node.id === openVector.id);
      const committedLine = snapshot?.nodes.find((node) => node.id === line.id);
      if (
        committedPolygon?.kind !== "polygon" || committedPolygon.parametricShape?.kind !== "polygon" || committedPolygon.parametricShape.pointCount !== 8
        || committedStar?.kind !== "star" || committedStar.parametricShape?.kind !== "star" || committedStar.parametricShape.pointCount !== 7 || committedStar.parametricShape.innerRatio !== .35
        || committedVector?.kind !== "vector" || committedVector.vectorPath?.fillRule !== "evenOdd" || committedVector.vectorPath.subpaths[0]?.closed !== true
        || committedVector.strokeWidth !== 3 || committedVector.strokeCapStart !== "round" || committedVector.strokeCapEnd !== "round" || committedVector.strokeJoin !== "bevel" || committedVector.strokeMiterLimit !== 4 || committedVector.strokeDashPattern?.length !== 6
        || committedOpenVector?.kind !== "vector" || committedOpenVector.vectorPath?.subpaths[0]?.closed !== false
        || committedLine?.kind !== "line" || committedLine.strokeWidth !== 5 || committedLine.strokeCapStart !== "arrowLines" || committedLine.strokeCapEnd !== "arrowLines" || committedLine.strokeDashPattern?.join(",") !== "12,6"
      ) {
        throw new Error("Worker projection did not preserve parametric, path or stroke geometry.");
      }
      append(`Geometry Ack + Projection fence passed at revision ${revision}.`);

      const exports = await Promise.all([polygon, star, vector, openVector, line].map((node) => node.exportAsync({ format: "SVG_STRING" })));
      if (exports.some((svg) => !svg.includes("<path"))) throw new Error("A committed geometry node did not export a path.");
      if (!exports[2]?.includes('fill-rule="evenodd"') || !exports[3]?.includes(" C ") || !exports[4]?.includes('stroke-dasharray="12 6"')) {
        throw new Error("SVG export lost the even-odd, open cubic or dashed line contract.");
      }
      append("Polygon, Star, open/self-intersecting Vector and dashed cap SVG export passed.");

      const undoPromise = waitForSnapshot(
        (next) => next.revision > revision && !next.nodes.some((node) => [polygon.id, star.id, vector.id, openVector.id, line.id].includes(node.id)),
        "parametric geometry Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      if (!polygon.removed || !star.removed || !vector.removed || !openVector.removed || !line.removed) throw new Error("Undo did not retire the created geometry proxy generations.");
      append(`Geometry Undo and proxy lifecycle passed at revision ${undone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown geometry harness failure.");
    }
  };

  const runBooleanGeometryScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const firstSource = runtime.createFrame();
      firstSource.name = "Runtime Boolean source A";
      firstSource.x = 40;
      firstSource.y = 40;
      const first = runtime.createVector();
      first.name = "Runtime Boolean outer";
      first.x = 0;
      first.y = 0;
      first.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 120 0 L 120 120 L 0 120 Z" }];
      firstSource.appendChild(first);
      const secondSource = runtime.createFrame();
      secondSource.name = "Runtime Boolean source B";
      secondSource.x = 40;
      secondSource.y = 40;
      const second = runtime.createVector();
      second.name = "Runtime Boolean cutout";
      second.x = 0;
      second.y = 0;
      second.vectorPaths = [{ windingRule: "NONZERO", data: "M 30 30 L 90 30 L 90 90 L 30 90 Z" }];
      secondSource.appendChild(second);
      const boolean = runtime.subtract([first, second], runtime.currentPage, 0);
      boolean.name = "Runtime Boolean ring";
      if (boolean.type !== "BOOLEAN_OPERATION" || boolean.booleanOperation !== "SUBTRACT" || boolean.children[0] !== first || boolean.children[1] !== second || first.parent !== boolean || firstSource.children.length !== 0 || secondSource.children.length !== 0) {
        throw new Error("Boolean structure did not provide read-your-writes before Ack.");
      }
      append("Cross-parent Boolean identity, operation, children and source reindexing passed before Ack.");

      const booleanRevision = await runtime.commitAsync();
      const committedBoolean = latestSnapshotRef.current?.nodes.find((node) => node.id === boolean.id);
      const committedOperands = latestSnapshotRef.current?.nodes.filter((node) => node.parentId === boolean.id) ?? [];
      if (committedBoolean?.kind !== "booleanOperation" || committedBoolean.booleanOperation !== "subtract" || committedOperands.length !== 2 || latestSnapshotRef.current?.nodes.some((node) => node.parentId === firstSource.id || node.parentId === secondSource.id)) {
        throw new Error("Worker projection did not preserve the live Boolean structure.");
      }
      append(`Cross-parent Boolean Ack + Projection fence passed at revision ${booleanRevision}.`);

      const flattened = runtime.flatten([boolean], firstSource, 0);
      if (flattened.type !== "VECTOR" || flattened.parent !== firstSource || firstSource.children[0] !== flattened || !boolean.removed || !first.removed || !second.removed) {
        throw new Error("Flatten did not synchronously replace the Boolean projection.");
      }
      const flattenedRevision = await runtime.commitAsync();
      const committedFlattened = latestSnapshotRef.current?.nodes.find((node) => node.id === flattened.id);
      if (committedFlattened?.kind !== "vector" || committedFlattened.parentId !== firstSource.id || committedFlattened.vectorPath?.subpaths.length !== 2 || latestSnapshotRef.current?.nodes.some((node) => node.id === boolean.id)) {
        throw new Error("Rust flatten did not publish the expected two-contour Vector replacement.");
      }
      const svg = await flattened.exportAsync({ format: "SVG_STRING" });
      if (!svg.includes("<path") || !svg.includes("fill-rule=")) throw new Error("Flattened Boolean did not export as a Vector path.");
      append(`Rust flatten, alternate parent/index, forced replacement identity and SVG export passed at revision ${flattenedRevision}.`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > flattenedRevision && snapshot.nodes.some((node) => node.id === boolean.id && node.kind === "booleanOperation"),
        "Boolean flatten Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const restoredBoolean = await runtime.getNodeByIdAsync(boolean.id);
      if (!flattened.removed || firstSource.children.length !== 0 || !restoredBoolean || restoredBoolean === boolean || restoredBoolean.type !== "BOOLEAN_OPERATION") {
        throw new Error("Undo did not restore a fresh live Boolean proxy generation.");
      }
      append(`Flatten Undo restored the live Boolean at revision ${undone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown Boolean geometry harness failure.");
    }
  };

  const runVectorNetworkScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const vector = runtime.createVector();
      vector.name = "Runtime VectorNetwork curve";
      vector.x = 80;
      vector.y = 80;
      const createdRevision = await runtime.commitAsync();
      append(`Vector creation fence passed at revision ${createdRevision}.`);

      const networkCommit = vector.setVectorNetworkAsync({
        vertices: [
          { x: 0, y: 0, strokeCap: "ROUND", handleMirroring: "ANGLE" },
          { x: 120, y: 64, strokeCap: "ARROW_EQUILATERAL", handleMirroring: "NONE" },
        ],
        segments: [{ start: 0, end: 1, tangentStart: { x: 32, y: 0 }, tangentEnd: { x: -32, y: 0 } }],
      });
      if (
        vector.strokeCap !== runtime.mixed
        || vector.vectorNetwork.vertices[0]?.strokeCap !== "ROUND"
        || vector.vectorNetwork.vertices[1]?.strokeCap !== "ARROW_EQUILATERAL"
        || !vector.vectorNetwork.segments[0]?.tangentStart
      ) throw new Error("VectorNetwork did not provide endpoint-cap and cubic read-your-writes before Ack.");
      append("VectorNetwork topology, tangents and asymmetric endpoint caps passed before Ack.");

      await networkCommit;
      const revision = latestSnapshotRef.current?.revision ?? createdRevision;
      const committed = latestSnapshotRef.current?.nodes.find((node) => node.id === vector.id);
      if (
        committed?.kind !== "vector"
        || committed.vectorPath?.subpaths[0]?.closed !== false
        || committed.vectorPath.subpaths[0].points[0]?.handleOut?.x !== 32
        || committed.vectorPath.subpaths[0].points[1]?.handleIn?.x !== -32
        || committed.strokeCapStart !== "round"
        || committed.strokeCapEnd !== "arrowEquilateral"
      ) throw new Error("Worker projection did not preserve the representable VectorNetwork subset.");
      const svg = await vector.exportAsync({ format: "SVG_STRING" });
      if (!svg.includes(" C ")) throw new Error("VectorNetwork cubic did not export through the confirmed SVG path.");
      append(`VectorNetwork Worker fence and SVG export passed at revision ${revision}.`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > revision && snapshot.nodes.find((node) => node.id === vector.id)?.vectorPath?.subpaths[0]?.closed === true,
        "VectorNetwork Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      if (vector.removed || vector.vectorNetwork.regions?.length !== 1 || vector.strokeCap === runtime.mixed) {
        throw new Error("Undo did not restore the original Vector topology and uniform cap.");
      }
      append(`VectorNetwork Undo restored the original live proxy at revision ${undone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown VectorNetwork harness failure.");
    }
  };

  const runSpecialNodesScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const hitCanvasSize = 1_200;
      worker.postMessage({ type: "resize", width: hitCanvasSize, height: hitCanvasSize, dpr: 1 } satisfies MainToWorker);
      const connector = runtime.createConnector();
      connector.name = "Runtime review connector";
      connector.x = 40;
      connector.y = 60;
      connector.connectorLineType = "ELBOWED";
      connector.reconnect(
        { position: { x: 0, y: 0 } },
        { position: { x: 220, y: 80 } },
      );
      connector.connectorStartStrokeCap = "CIRCLE_FILLED";
      connector.connectorEndStrokeCap = "TRIANGLE_FILLED";
      connector.connectorText = "Review";
      const connectorEnd = connector.connectorEnd;
      if (
        connector.connectorLineType !== "ELBOWED"
        || !("position" in connectorEnd)
        || connectorEnd.position.y !== 80
        || connector.connectorText !== "Review"
      ) {
        throw new Error("Connector did not provide read-your-writes before Ack.");
      }
      const connectorRevision = await runtime.commitAsync();
      append(`Connector Ack + Projection fence passed at revision ${connectorRevision}.`);
      connector.connectorText = "Review updated";
      const connectorEditRevision = await runtime.commitAsync();
      append(`Confirmed Connector metadata edit passed at revision ${connectorEditRevision}.`);

      const shape = runtime.createShapeWithText();
      shape.name = "Runtime decision";
      shape.x = 340;
      shape.y = 40;
      shape.shapeType = "DIAMOND";
      const shapeText = shape.text;
      if (shape.text !== shapeText) throw new Error("ShapeWithText did not retain stable TextSublayer identity.");
      shapeText.characters = "Approve now";
      shapeText.setRangeFontSize(0, 7, 18);
      shapeText.setRangeFontSize(7, 11, 22);
      shapeText.setRangeLetterSpacing(0, 11, { value: 1.5, unit: "PIXELS" });
      shapeText.setRangeFills(0, 7, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5 }]);
      shapeText.setRangeFills(7, 11, [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: .75 }]);
      const approveFills = shapeText.getRangeFills(0, 7);
      if (
        shape.shapeType !== "DIAMOND" || shapeText.characters !== "Approve now" || shapeText.fontSize !== runtime.mixed
        || shapeText.getRangeFontSize(0, 7) !== 18 || shapeText.getRangeFontSize(7, 11) !== 22
        || shapeText.fills !== runtime.mixed
        || approveFills === runtime.mixed || approveFills.length !== 1
        || approveFills[0]?.type !== "SOLID"
        || approveFills[0].color.r !== 1 || approveFills[0].color.g !== 0 || approveFills[0].color.b !== 0
        || approveFills[0].visible !== true || approveFills[0].opacity !== .5 || approveFills[0].blendMode !== "NORMAL"
      ) throw new Error("ShapeWithText TextSublayer did not provide styled read-your-writes before Ack.");
      const shapeRevision = await runtime.commitAsync();
      const simpleShapeCanvas = await waitForFrameHash(
        (frame) => frame.revision === shapeRevision,
        "ShapeWithText simple range-fill frame hash",
      );
      append(`ShapeWithText styled TextSublayer Ack + Projection fence passed at revision ${shapeRevision}.`);
      shapeText.insertCharacters(7, "d", "AFTER");
      const insertedFills = shapeText.getRangeFills(7, 8);
      if (
        shape.characters !== "Approved now" || shapeText.getRangeFontSize(7, 8) !== 22
        || shapeText.getRangeLetterSpacing(0, 12) === runtime.mixed
        || insertedFills === runtime.mixed || insertedFills.length !== 1
        || insertedFills[0]?.type !== "SOLID"
        || insertedFills[0].color.r !== 0 || insertedFills[0].color.g !== 0 || insertedFills[0].color.b !== 1
        || insertedFills[0].visible !== true || insertedFills[0].opacity !== .75 || insertedFills[0].blendMode !== "NORMAL"
      ) throw new Error("ShapeWithText TextSublayer AFTER range edit did not preserve the following style.");

      const rangeImageBytes = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9M5W8AAAAASUVORK5CYII="),
        (character) => character.charCodeAt(0),
      );
      const rangeImage = await runtime.createImageAsync(rangeImageBytes, "image/png", { timeoutMs: 10_000 });
      shapeText.setRangeFills(0, 7, []);
      shapeText.setRangeFills(7, 12, [
        { type: "SOLID", color: { r: 0, g: .2, b: 1 }, opacity: .4 },
        {
          type: "GRADIENT_LINEAR",
          gradientTransform: [[1, 0, 0], [0, 1, 0]],
          gradientStops: [
            { position: 0, color: { r: 1, g: .1, b: .1, a: 1 } },
            { position: 1, color: { r: .1, g: 1, b: .5, a: .7 } },
          ],
          opacity: .65,
          blendMode: "MULTIPLY",
        },
        { type: "IMAGE", imageHash: rangeImage.hash, scaleMode: "TILE", scalingFactor: .5, opacity: .3, blendMode: "SCREEN" },
      ]);
      const emptyRangeFills = shapeText.getRangeFills(0, 7);
      const layeredRangeFills = shapeText.getRangeFills(7, 12);
      if (
        shapeText.fills !== runtime.mixed
        || emptyRangeFills === runtime.mixed || emptyRangeFills.length !== 0
        || layeredRangeFills === runtime.mixed || layeredRangeFills.length !== 3
        || layeredRangeFills[0]?.type !== "SOLID"
        || layeredRangeFills[1]?.type !== "GRADIENT_LINEAR" || layeredRangeFills[1].blendMode !== "MULTIPLY"
        || layeredRangeFills[2]?.type !== "IMAGE" || layeredRangeFills[2].imageHash !== rangeImage.hash
        || layeredRangeFills[2].scaleMode !== "TILE" || layeredRangeFills[2].blendMode !== "SCREEN"
      ) throw new Error("ShapeWithText did not preserve explicit empty and three-layer TextSublayer PaintStacks before Ack.");
      const shapeEditRevision = await runtime.commitAsync();
      const layeredShapeCanvas = await waitForFrameHash(
        (frame) => frame.revision === shapeEditRevision,
        "ShapeWithText layered range-fill frame hash",
      );
      if (layeredShapeCanvas.rgbaSha256 === simpleShapeCanvas.rgbaSha256) {
        throw new Error("ShapeWithText per-run PaintStack edit did not change the real Worker Canvas frame.");
      }
      const confirmedShapeRuns = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id)?.textProperties?.runs;
      if (
        confirmedShapeRuns?.length !== 2
        || confirmedShapeRuns[0]?.fillStack?.layers.length !== 0
        || confirmedShapeRuns[1]?.fillStack?.layers.length !== 3
        || confirmedShapeRuns[1].fillStack.layers[1]?.blendMode !== "multiply"
        || confirmedShapeRuns[1].fillStack.layers[2]?.image?.assetId !== rangeImage.hash
      ) throw new Error("Worker/Core did not preserve ShapeWithText range PaintStack presence, order, blend or image identity.");
      append(`Confirmed ShapeWithText empty/multi-layer range PaintStacks changed Canvas ${simpleShapeCanvas.rgbaSha256} → ${layeredShapeCanvas.rgbaSha256} at revision ${shapeEditRevision}.`);

      const source = runtime.createVector();
      source.name = "Runtime text path source";
      source.x = 620;
      source.y = 80;
      source.vectorPaths = [{ windingRule: "NONE", data: "M 0 70 C 40 0 180 0 220 70" }];
      const sourceRevision = await runtime.commitAsync();
      append(`TextPath source Vector fence passed at revision ${sourceRevision}.`);
      const textPath = runtime.createTextPath(source, 0, .25);
      textPath.characters = "Along the curve";
      textPath.textAlignHorizontal = "CENTER";
      textPath.textAlignVertical = "TOP";
      textPath.autoRename = false;

      if (
        textPath.type !== "TEXT_PATH" || textPath.textPathStartData.position !== .25 || textPath.characters !== "Along the curve"
        || !source.removed
      ) throw new Error("TextPath did not provide Figma-shaped read-your-writes before Ack.");
      append("Atomic Vector-to-TextPath replacement passed before Ack.");

      const conversionRevision = await runtime.commitAsync();
      append(`TextPath replacement fence passed at revision ${conversionRevision}.`);
      textPath.characters = "Curved review";
      const revision = await runtime.commitAsync();
      const snapshot = latestSnapshotRef.current;
      const committedConnector = snapshot?.nodes.find((node) => node.id === connector.id);
      const committedShape = snapshot?.nodes.find((node) => node.id === shape.id);
      const committedTextPath = snapshot?.nodes.find((node) => node.id === textPath.id);
      if (
        committedConnector?.kind !== "connector" || committedConnector.connectorMetadata?.lineType !== "ELBOWED" || committedConnector.connectorMetadata.text !== "Review updated"
        || committedShape?.kind !== "shapeWithText" || committedShape.shapeWithTextType !== "DIAMOND" || committedShape.text !== "Approved now"
        || committedTextPath?.kind !== "textPath" || committedTextPath.textPathMetadata?.startPosition !== .25 || committedTextPath.text !== "Curved review"
        || snapshot?.nodes.some((node) => node.id === source.id)
      ) throw new Error("Worker projection did not preserve the special-node metadata or atomic TextPath replacement.");
      append(`Special-node Ack + Projection fence passed at revision ${revision}.`);

      const [connectorSvg, shapeSvg, textPathSvg] = await Promise.all([
        connector.exportAsync({ format: "SVG_STRING" }),
        shape.exportAsync({ format: "SVG_STRING" }),
        textPath.exportAsync({ format: "SVG_STRING" }),
      ]);
      if (
        !connectorSvg.includes("<path") || !connectorSvg.includes("Review updated")
        || !shapeSvg.includes("Appr") || !shapeSvg.includes("d now")
        || (shapeSvg.match(/<text /gu)?.length ?? 0) !== 3
        || !shapeSvg.includes('fill="none"') || !shapeSvg.includes("<linearGradient")
        || !shapeSvg.includes("<pattern") || !shapeSvg.includes("mix-blend-mode:multiply")
        || !shapeSvg.includes("mix-blend-mode:screen")
        || (textPathSvg.match(/<text /gu)?.length ?? 0) !== [..."Curved review"].length
        || !textPathSvg.includes(">C</text>")
      ) {
        throw new Error("Special-node SVG export lost geometry or stored text.");
      }
      append("Connector, ShapeWithText and TextPath exported from the same confirmed scene.");

      const textUndoPromise = waitForSnapshot((next) => next.revision > revision && next.nodes.some((node) => node.id === textPath.id && node.text === "Along the curve"), "TextPath text Undo projection");
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const textUndone = await textUndoPromise;
      append(`Confirmed TextPath text Undo passed at revision ${textUndone.revision}.`);
      const undoPromise = waitForSnapshot((next) => next.revision > textUndone.revision && next.nodes.some((node) => node.id === source.id), "TextPath replacement Undo projection");
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const restoredSource = await runtime.getNodeByIdAsync(source.id);
      if (!textPath.removed || !restoredSource || restoredSource === source || restoredSource.type !== "VECTOR") throw new Error("Undo did not restore a fresh Vector proxy generation.");
      append(`TextPath Undo restored the source Vector at revision ${undone.revision}.`);

      const repeatRectangle = runtime.createRectangle();
      repeatRectangle.name = "Repeat rectangle";
      repeatRectangle.x = 40;
      repeatRectangle.y = 300;
      repeatRectangle.resize(100, 80);
      const repeatEllipse = runtime.createEllipse();
      repeatEllipse.name = "Repeat ellipse";
      repeatEllipse.x = 180;
      repeatEllipse.y = 300;
      repeatEllipse.resize(100, 80);
      const repeatResizeSibling = runtime.createRectangle();
      repeatResizeSibling.name = "Repeat resize sibling";
      repeatResizeSibling.x = 760;
      repeatResizeSibling.y = 300;
      repeatResizeSibling.resize(80, 80);
      const repeatAxis = (modifiers: readonly DocumentTransformModifier[] | undefined) => {
        const modifier = modifiers?.[0];
        return modifier?.repeatType === "LINEAR" ? modifier.axis : undefined;
      };
      const repeatKind = (modifiers: readonly DocumentTransformModifier[] | undefined) => modifiers?.[0]?.repeatType;
      const horizontalRepeat = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 260, axis: "HORIZONTAL" as const }];
      const repeatGroup = runtime.transformGroup(
        [repeatRectangle, repeatEllipse],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        horizontalRepeat,
      );
      repeatGroup.name = "Runtime repeated pair";
      if (
        repeatGroup.type !== "TRANSFORM_GROUP" || repeatGroup.children.length !== 2
        || repeatAxis(repeatGroup.transformModifiers) !== "HORIZONTAL"
        || repeatRectangle.parent?.id !== repeatGroup.id || repeatEllipse.parent?.id !== repeatGroup.id
      ) throw new Error("TransformGroup Repeat did not preserve pending structure or modifiers.");
      append("TransformGroup Repeat structure, order and modifiers passed before Ack.");
      const repeatRevision = await runtime.commitAsync();
      const confirmedRepeat = latestSnapshotRef.current?.nodes.find((node) => node.id === repeatGroup.id);
      if (
        confirmedRepeat?.kind !== "transformGroup" || repeatAxis(confirmedRepeat.transformModifiers) !== "HORIZONTAL"
        || latestSnapshotRef.current?.nodes.filter((node) => node.parentId === repeatGroup.id).length !== 2
      ) throw new Error("Worker projection did not preserve the linear Repeat group.");
      append(`TransformGroup Repeat fence passed at revision ${repeatRevision}.`);

      repeatGroup.transformModifiers = [{ type: "REPEAT", repeatType: "LINEAR", count: 2, unitType: "PIXELS", offset: 180, axis: "VERTICAL" }];
      const repeatEditRevision = await runtime.commitAsync();
      const repeatSvg = await repeatGroup.exportAsync({ format: "SVG_STRING" });
      if (
        repeatAxis(repeatGroup.transformModifiers) !== "VERTICAL"
        || !repeatSvg.includes('transform="matrix(1 0 0 1 0 180)"')
        || !repeatSvg.includes('transform="matrix(1 0 0 1 0 360)"')
        || (repeatSvg.match(/<path /gu)?.length ?? 0) < 3
      ) throw new Error(`Confirmed Repeat modifier or SVG materialization was incomplete: axis=${repeatAxis(repeatGroup.transformModifiers) ?? "missing"}, firstMatrix=${repeatSvg.includes('transform="matrix(1 0 0 1 0 180)"')}, secondMatrix=${repeatSvg.includes('transform="matrix(1 0 0 1 0 360)"')}, paths=${repeatSvg.match(/<path /gu)?.length ?? 0}.`);
      append(`Confirmed vertical Repeat edit and bounded SVG materialization passed at revision ${repeatEditRevision}.`);

      repeatGroup.transformModifiers = [{ type: "REPEAT", repeatType: "RADIAL", count: 3, unitType: "PIXELS", offset: 120 }];
      const radialRepeatRevision = await runtime.commitAsync();
      const radialRepeatSvg = await repeatGroup.exportAsync({ format: "SVG_STRING" });
      if (
        repeatKind(repeatGroup.transformModifiers) !== "RADIAL"
        || !radialRepeatSvg.includes('transform="matrix(0 1 -1 0')
        || !radialRepeatSvg.includes('transform="matrix(-1 0 0 -1')
        || (radialRepeatSvg.match(/<path /gu)?.length ?? 0) < 4
      ) throw new Error(`Confirmed radial Repeat modifier or SVG materialization was incomplete: kind=${repeatKind(repeatGroup.transformModifiers) ?? "missing"}, quarterTurn=${radialRepeatSvg.includes('transform="matrix(0 1 -1 0')}, halfTurn=${radialRepeatSvg.includes('transform="matrix(-1 0 0 -1')}, paths=${radialRepeatSvg.match(/<path /gu)?.length ?? 0}.`);
      append(`Confirmed radial Repeat edit and bounded SVG materialization passed at revision ${radialRepeatRevision}.`);

      repeatGroup.transformModifiers = [
        { type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 100, axis: "HORIZONTAL" },
        { type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 80, axis: "VERTICAL" },
      ];
      const stackedRepeatRevision = await runtime.commitAsync();
      const stackedRepeatSvg = await repeatGroup.exportAsync({ format: "SVG_STRING" });
      if (
        repeatGroup.transformModifiers.length !== 2
        || !stackedRepeatSvg.includes('transform="matrix(1 0 0 1 100 0)"')
        || !stackedRepeatSvg.includes('transform="matrix(1 0 0 1 0 80)"')
        || !stackedRepeatSvg.includes('transform="matrix(1 0 0 1 100 80)"')
      ) throw new Error("Confirmed stacked Repeat modifier or derived grid materialization was incomplete.");
      append(`Confirmed stacked Repeat edit and bounded SVG grid materialization passed at revision ${stackedRepeatRevision}.`);

      const resizeBeforeSnapshot = latestSnapshotRef.current;
      const resizeBeforeGroup = resizeBeforeSnapshot?.nodes.find((node) => node.id === repeatGroup.id);
      const resizeBeforeSource = resizeBeforeSnapshot?.nodes.find((node) => node.id === repeatRectangle.id);
      const resizeBeforeSibling = resizeBeforeSnapshot?.nodes.find((node) => node.id === repeatResizeSibling.id);
      const resizeSelection = resizeBeforeSnapshot && resolveMultiResizeSelection(
        resizeBeforeSnapshot.nodes,
        [repeatGroup.id, repeatResizeSibling.id],
      );
      const repeatBoundsBefore = resizeBeforeSnapshot && resizeBeforeGroup
        ? transformGroupRepeatWorldBounds(resizeBeforeSnapshot.nodes, resizeBeforeGroup)
        : undefined;
      if (!resizeBeforeSnapshot || !resizeBeforeGroup || !resizeBeforeSource || !resizeBeforeSibling || !resizeSelection || !repeatBoundsBefore)
        throw new Error("Repeat multi-resize fixture could not resolve its derived selection geometry.");
      const selectedPromise = waitForViewState(
        (message) => message.selectedIds.length === 2
          && message.selectedIds.includes(repeatGroup.id)
          && message.selectedIds.includes(repeatResizeSibling.id),
        "Repeat multi-resize selection",
      );
      worker.postMessage({ type: "command", command: { type: "select", ids: [repeatGroup.id, repeatResizeSibling.id] } } satisfies MainToWorker);
      await selectedPromise;
      const resizeDeltaScreen = 120;
      const resizeHandle = {
        x: (resizeSelection.bounds.x + resizeSelection.bounds.width + resizeBeforeSnapshot.viewport.x) * resizeBeforeSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (resizeSelection.bounds.y + resizeSelection.bounds.height / 2 + resizeBeforeSnapshot.viewport.y) * resizeBeforeSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const resizeCommitPromise = waitForSnapshot(
        (next) => next.revision > stackedRepeatRevision
          && JSON.stringify(next.nodes.find((node) => node.id === repeatGroup.id)?.relativeTransform) !== JSON.stringify(resizeBeforeGroup.relativeTransform),
        "Repeat multi-resize projection",
      );
      worker.postMessage({ type: "pointer", event: "down", ...resizeHandle, shiftKey: false, altKey: false, button: 0 } satisfies MainToWorker);
      worker.postMessage({ type: "pointer", event: "move", x: resizeHandle.x + resizeDeltaScreen, y: resizeHandle.y, shiftKey: false, altKey: false, button: 0 } satisfies MainToWorker);
      worker.postMessage({ type: "pointer", event: "up", x: resizeHandle.x + resizeDeltaScreen, y: resizeHandle.y, shiftKey: false, altKey: false, button: 0 } satisfies MainToWorker);
      const resizeAfterSnapshot = await resizeCommitPromise;
      const resizeAfterGroup = resizeAfterSnapshot.nodes.find((node) => node.id === repeatGroup.id);
      const resizeAfterSource = resizeAfterSnapshot.nodes.find((node) => node.id === repeatRectangle.id);
      const repeatBoundsAfter = resizeAfterGroup
        ? transformGroupRepeatWorldBounds(resizeAfterSnapshot.nodes, resizeAfterGroup)
        : undefined;
      const deltaWorld = resizeDeltaScreen / resizeBeforeSnapshot.viewport.zoom;
      const scaleX = (resizeSelection.bounds.width + deltaWorld) / resizeSelection.bounds.width;
      const expectedRepeatRight = resizeSelection.bounds.x
        + (repeatBoundsBefore.right - resizeSelection.bounds.x) * scaleX;
      if (
        !resizeAfterGroup || !resizeAfterSource || !repeatBoundsAfter
        || resizeAfterGroup.width !== resizeBeforeGroup.width || resizeAfterGroup.height !== resizeBeforeGroup.height
        || JSON.stringify(resizeAfterSource.relativeTransform) !== JSON.stringify(resizeBeforeSource.relativeTransform)
        || Math.abs(repeatBoundsAfter.left - repeatBoundsBefore.left) > 1e-6
        || Math.abs(repeatBoundsAfter.right - expectedRepeatRight) > 1e-6
      ) throw new Error("Repeat multi-resize did not apply one affine wrapper transform to source and derived occurrences.");
      append(`Repeat + sibling collective resize committed one affine wrapper update at revision ${resizeAfterSnapshot.revision}.`);

      const resizeUndoPromise = waitForSnapshot(
        (next) => next.revision > resizeAfterSnapshot.revision
          && JSON.stringify(next.nodes.find((node) => node.id === repeatGroup.id)?.relativeTransform) === JSON.stringify(resizeBeforeGroup.relativeTransform),
        "Repeat multi-resize Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const resizeUndone = await resizeUndoPromise;
      const resizeUndoSibling = resizeUndone.nodes.find((node) => node.id === repeatResizeSibling.id);
      if (!resizeUndoSibling || resizeUndoSibling.x !== resizeBeforeSibling.x || resizeUndoSibling.width !== resizeBeforeSibling.width)
        throw new Error("Repeat multi-resize Undo did not restore its sibling in the same history item.");
      append(`Repeat collective resize Undo restored both affine roots at revision ${resizeUndone.revision}.`);

      const repeatOnlySelectionPromise = waitForViewState(
        (message) => message.selectedIds.length === 1 && message.selectedIds[0] === repeatGroup.id,
        "Repeat boundary-hit fixture selection",
      );
      worker.postMessage({ type: "command", command: { type: "select", ids: [repeatGroup.id] } } satisfies MainToWorker);
      await repeatOnlySelectionPromise;

      const singleResizeBeforeSnapshot = latestSnapshotRef.current;
      const singleResizeBeforeGroup = singleResizeBeforeSnapshot?.nodes.find((node) => node.id === repeatGroup.id);
      const singleResizeBeforeSource = singleResizeBeforeSnapshot?.nodes.find((node) => node.id === repeatRectangle.id);
      const singleResizeSelection = singleResizeBeforeSnapshot
        ? resolveMultiResizeSelection(singleResizeBeforeSnapshot.nodes, [repeatGroup.id])
        : undefined;
      const singleRepeatBoundsBefore = singleResizeBeforeSnapshot && singleResizeBeforeGroup
        ? transformGroupRepeatWorldBounds(singleResizeBeforeSnapshot.nodes, singleResizeBeforeGroup)
        : undefined;
      if (!singleResizeBeforeSnapshot || !singleResizeBeforeGroup || !singleResizeBeforeSource || !singleResizeSelection || !singleRepeatBoundsBefore)
        throw new Error("Single Repeat resize fixture could not resolve its complete visual envelope.");
      const singleResizeDeltaScreen = 80;
      const singleResizeHandle = {
        x: (singleResizeSelection.bounds.x + singleResizeSelection.bounds.width + singleResizeBeforeSnapshot.viewport.x) * singleResizeBeforeSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (singleResizeSelection.bounds.y + singleResizeSelection.bounds.height / 2 + singleResizeBeforeSnapshot.viewport.y) * singleResizeBeforeSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const singleResizeCommitPromise = waitForSnapshot(
        (next) => next.revision > resizeUndone.revision
          && JSON.stringify(next.nodes.find((node) => node.id === repeatGroup.id)?.relativeTransform) !== JSON.stringify(singleResizeBeforeGroup.relativeTransform),
        "single Repeat resize projection",
      );
      worker.postMessage({ type: "pointer", event: "down", ...singleResizeHandle, shiftKey: false, altKey: false, button: 0 } satisfies MainToWorker);
      worker.postMessage({ type: "pointer", event: "move", x: singleResizeHandle.x + singleResizeDeltaScreen, y: singleResizeHandle.y, shiftKey: false, altKey: false, button: 0 } satisfies MainToWorker);
      worker.postMessage({ type: "pointer", event: "up", x: singleResizeHandle.x + singleResizeDeltaScreen, y: singleResizeHandle.y, shiftKey: false, altKey: false, button: 0 } satisfies MainToWorker);
      const singleResizeAfterSnapshot = await singleResizeCommitPromise;
      const singleResizeAfterGroup = singleResizeAfterSnapshot.nodes.find((node) => node.id === repeatGroup.id);
      const singleResizeAfterSource = singleResizeAfterSnapshot.nodes.find((node) => node.id === repeatRectangle.id);
      const singleRepeatBoundsAfter = singleResizeAfterGroup
        ? transformGroupRepeatWorldBounds(singleResizeAfterSnapshot.nodes, singleResizeAfterGroup)
        : undefined;
      const singleDeltaWorld = singleResizeDeltaScreen / singleResizeBeforeSnapshot.viewport.zoom;
      if (
        !singleResizeAfterGroup || !singleResizeAfterSource || !singleRepeatBoundsAfter
        || singleResizeAfterGroup.width !== singleResizeBeforeGroup.width
        || singleResizeAfterGroup.height !== singleResizeBeforeGroup.height
        || JSON.stringify(singleResizeAfterSource.relativeTransform) !== JSON.stringify(singleResizeBeforeSource.relativeTransform)
        || Math.abs(singleRepeatBoundsAfter.left - singleRepeatBoundsBefore.left) > 1e-6
        || Math.abs(singleRepeatBoundsAfter.right - (singleRepeatBoundsBefore.right + singleDeltaWorld)) > 1e-6
      ) throw new Error("Single Repeat resize did not scale the complete visual envelope through only its canonical wrapper.");
      append(`Single Repeat edge resize committed one affine wrapper update at revision ${singleResizeAfterSnapshot.revision}.`);
      const singleResizeUndoPromise = waitForSnapshot(
        (next) => next.revision > singleResizeAfterSnapshot.revision
          && JSON.stringify(next.nodes.find((node) => node.id === repeatGroup.id)?.relativeTransform) === JSON.stringify(singleResizeBeforeGroup.relativeTransform),
        "single Repeat resize Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const singleResizeUndone = await singleResizeUndoPromise;
      append(`Single Repeat resize Undo restored the wrapper at revision ${singleResizeUndone.revision}.`);

      const repeatHitSnapshot = latestSnapshotRef.current;
      const repeatHitRevision = singleResizeUndone.revision;
      const repeatHitGroup = repeatHitSnapshot?.nodes.find((node) => node.id === repeatGroup.id);
      const repeatHitSource = repeatHitSnapshot?.nodes.find((node) => node.id === repeatRectangle.id);
      const repeatHitMatrices = repeatHitSnapshot && repeatHitGroup
        ? transformGroupRepeatMatrices(repeatHitSnapshot.nodes, repeatHitGroup)
        : undefined;
      const repeatHitSourceWorld = repeatHitSnapshot && repeatHitSource
        ? worldTransformForNode(repeatHitSnapshot.nodes, repeatHitSource.id)
        : undefined;
      const repeatHitMatrix = repeatHitMatrices?.at(-1);
      if (!repeatHitSnapshot || !repeatHitSource || !repeatHitSourceWorld || !repeatHitMatrix)
        throw new Error("Repeat hit-test fixture could not resolve its derived world geometry.");
      const sourceWorldCenter = transformPoint(repeatHitSourceWorld, { x: repeatHitSource.width / 2, y: repeatHitSource.height / 2 });
      const derivedWorldCenter = transformPoint(repeatHitMatrix, sourceWorldCenter);
      const derivedScreenPoint = {
        x: (derivedWorldCenter.x + repeatHitSnapshot.viewport.x) * repeatHitSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (derivedWorldCenter.y + repeatHitSnapshot.viewport.y) * repeatHitSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const boundaryHitPromise = waitForViewState(
        () => true,
        "derived Repeat boundary selection",
      );
      worker.postMessage({ type: "pointer", event: "down", ...derivedScreenPoint, shiftKey: false, altKey: false, button: 0, readOnly: true } satisfies MainToWorker);
      const boundaryHit = await boundaryHitPromise;
      if (boundaryHit.selectedIds.length !== 1 || boundaryHit.selectedIds[0] !== repeatGroup.id)
        throw new Error(`Derived Repeat boundary hit selected ${boundaryHit.selectedIds.join(",") || "nothing"} instead of ${repeatGroup.id} at world ${derivedWorldCenter.x},${derivedWorldCenter.y} / screen ${derivedScreenPoint.x},${derivedScreenPoint.y}.`);
      if (latestSnapshotRef.current?.revision !== repeatHitRevision)
        throw new Error("Read-only derived Repeat boundary hit advanced the Canonical revision.");
      append(`Derived Repeat hit selected the TransformGroup boundary without a revision at ${boundaryHit.selectedIds[0]}.`);
      const deepHitPromise = waitForViewState(
        () => true,
        "derived Repeat deep selection",
      );
      worker.postMessage({ type: "pointer", event: "down", ...derivedScreenPoint, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const deepHit = await deepHitPromise;
      if (deepHit.selectedIds.length !== 1 || deepHit.selectedIds[0] !== repeatRectangle.id)
        throw new Error(`Derived Repeat deep hit selected ${deepHit.selectedIds.join(",") || "nothing"} instead of ${repeatRectangle.id}.`);
      if (latestSnapshotRef.current?.revision !== repeatHitRevision)
        throw new Error("Read-only derived Repeat deep hit advanced the Canonical revision.");
      append(`Derived Repeat deep-select resolved the source node without a revision at ${deepHit.selectedIds[0]}.`);

      const stackedRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > stackedRepeatRevision && repeatKind(next.nodes.find((node) => node.id === repeatGroup.id)?.transformModifiers) === "RADIAL",
        "stacked Repeat modifier Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const stackedRepeatUndone = await stackedRepeatUndoPromise;
      if (repeatKind(repeatGroup.transformModifiers) !== "RADIAL") throw new Error("Undo did not restore the radial Repeat modifier.");
      append(`Stacked Repeat modifier Undo passed at revision ${stackedRepeatUndone.revision}.`);
      const radialRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > stackedRepeatUndone.revision && repeatAxis(next.nodes.find((node) => node.id === repeatGroup.id)?.transformModifiers) === "VERTICAL",
        "radial Repeat modifier Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialRepeatUndone = await radialRepeatUndoPromise;
      if (repeatAxis(repeatGroup.transformModifiers) !== "VERTICAL") throw new Error("Undo did not restore the vertical Repeat modifier.");
      append(`Radial Repeat modifier Undo passed at revision ${radialRepeatUndone.revision}.`);
      const repeatEditUndoPromise = waitForSnapshot(
        (next) => next.revision > radialRepeatUndone.revision && repeatAxis(next.nodes.find((node) => node.id === repeatGroup.id)?.transformModifiers) === "HORIZONTAL",
        "linear Repeat modifier Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const repeatEditUndone = await repeatEditUndoPromise;
      if (repeatAxis(repeatGroup.transformModifiers) !== "HORIZONTAL") throw new Error("Undo did not restore the original Repeat modifier.");
      append(`Linear Repeat modifier Undo passed at revision ${repeatEditUndone.revision}.`);
      const repeatCreateUndoPromise = waitForSnapshot(
        (next) => next.revision > repeatEditUndone.revision && !next.nodes.some((node) => node.id === repeatGroup.id),
        "Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const repeatCreateUndone = await repeatCreateUndoPromise;
      if (!repeatGroup.removed || !repeatRectangle.removed || !repeatEllipse.removed) throw new Error("Undo did not retire the Repeat group and same-transaction sources.");
      append(`Repeat creation Undo retired the group and sources at revision ${repeatCreateUndone.revision}.`);

      const nestedGroup = runtime.createGroup();
      nestedGroup.name = "Nested Repeat source";
      const nestedFrame = runtime.createFrame();
      nestedFrame.name = "Clipped Repeat frame";
      nestedFrame.x = 40;
      nestedFrame.y = 520;
      nestedFrame.resize(100, 80);
      nestedFrame.fills = [];
      const nestedLeaf = runtime.createEllipse();
      nestedLeaf.name = "Clipped Repeat leaf";
      nestedLeaf.x = 100;
      nestedLeaf.y = 540;
      nestedLeaf.resize(60, 40);
      nestedFrame.appendChild(nestedLeaf);
      nestedGroup.appendChild(nestedFrame);
      const nestedRepeat = runtime.transformGroup(
        [nestedGroup],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      nestedRepeat.name = "Runtime nested repeated subtree";
      const nestedRepeatRevision = await runtime.commitAsync();
      const nestedSnapshot = latestSnapshotRef.current;
      const nestedCanonicalGroup = nestedSnapshot?.nodes.find((node) => node.id === nestedRepeat.id);
      const nestedCanonicalFrame = nestedSnapshot?.nodes.find((node) => node.id === nestedFrame.id);
      const nestedCanonicalLeaf = nestedSnapshot?.nodes.find((node) => node.id === nestedLeaf.id);
      const nestedMatrix = nestedSnapshot && nestedCanonicalGroup
        ? transformGroupRepeatMatrices(nestedSnapshot.nodes, nestedCanonicalGroup)?.[0]
        : undefined;
      const nestedLeafWorld = nestedSnapshot && nestedCanonicalLeaf
        ? worldTransformForNode(nestedSnapshot.nodes, nestedCanonicalLeaf.id)
        : undefined;
      const nestedSvg = await nestedRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        nestedCanonicalFrame?.clipsContent === false || !nestedMatrix || !nestedLeafWorld
        || !nestedSvg.includes("<clipPath") || !nestedSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Nested Repeat did not preserve its clipped container subtree or frozen SVG.");
      append(`Nested Group/Frame Repeat fence and clipped SVG passed at revision ${nestedRepeatRevision}.`);

      const nestedInsideWorld = transformPoint(nestedMatrix, transformPoint(nestedLeafWorld, { x: 30, y: 20 }));
      const nestedInsideScreen = {
        x: (nestedInsideWorld.x + nestedSnapshot!.viewport.x) * nestedSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (nestedInsideWorld.y + nestedSnapshot!.viewport.y) * nestedSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const nestedBoundaryPromise = waitForViewState(() => true, "nested derived Repeat boundary selection");
      worker.postMessage({ type: "pointer", event: "down", ...nestedInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true } satisfies MainToWorker);
      const nestedBoundary = await nestedBoundaryPromise;
      if (nestedBoundary.selectedIds[0] !== nestedRepeat.id) throw new Error("Nested derived Repeat did not select its TransformGroup boundary.");
      const nestedDeepPromise = waitForViewState(() => true, "nested derived Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...nestedInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const nestedDeep = await nestedDeepPromise;
      if (nestedDeep.selectedIds[0] !== nestedLeaf.id) throw new Error(`Nested derived Repeat deep hit selected ${nestedDeep.selectedIds.join(",") || "nothing"} instead of its leaf.`);

      const nestedOutsideWorld = transformPoint(nestedMatrix, transformPoint(nestedLeafWorld, { x: 50, y: 20 }));
      const nestedOutsideScreen = {
        x: (nestedOutsideWorld.x + nestedSnapshot!.viewport.x) * nestedSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (nestedOutsideWorld.y + nestedSnapshot!.viewport.y) * nestedSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const nestedClipPromise = waitForViewState(() => true, "nested derived Repeat clip rejection");
      worker.postMessage({ type: "pointer", event: "down", ...nestedOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const nestedClipped = await nestedClipPromise;
      if (nestedClipped.selectedIds.includes(nestedLeaf.id)) throw new Error("Nested Repeat hit escaped the source Frame clip.");
      if (latestSnapshotRef.current?.revision !== nestedRepeatRevision) throw new Error("Nested derived Repeat selection advanced the Canonical revision.");
      append("Nested Repeat boundary/deep-select and source Frame clip passed without a revision.");

      const nestedUndoPromise = waitForSnapshot(
        (next) => next.revision > nestedRepeatRevision && !next.nodes.some((node) => node.id === nestedRepeat.id),
        "nested Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const nestedUndone = await nestedUndoPromise;
      if (!nestedRepeat.removed || !nestedGroup.removed || !nestedFrame.removed || !nestedLeaf.removed) {
        throw new Error("Undo did not retire the nested Repeat subtree atomically.");
      }
      append(`Nested Repeat creation Undo retired the complete subtree at revision ${nestedUndone.revision}.`);

      const nestedRepeatLeaf = runtime.createRectangle();
      nestedRepeatLeaf.name = "Nested TransformGroup source";
      nestedRepeatLeaf.x = 40;
      nestedRepeatLeaf.y = 520;
      nestedRepeatLeaf.resize(40, 30);
      const innerRepeat = runtime.transformGroup(
        [nestedRepeatLeaf],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 120, axis: "VERTICAL" }],
      );
      innerRepeat.name = "Inner Repeat";
      const outerRepeat = runtime.transformGroup(
        [innerRepeat],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      outerRepeat.name = "Outer Repeat";
      const nestedTransformGroupRevision = await runtime.commitAsync();
      const nestedTransformSnapshot = latestSnapshotRef.current;
      const outerCanonical = nestedTransformSnapshot?.nodes.find((node) => node.id === outerRepeat.id);
      const innerCanonical = nestedTransformSnapshot?.nodes.find((node) => node.id === innerRepeat.id);
      const nestedLeafCanonical = nestedTransformSnapshot?.nodes.find((node) => node.id === nestedRepeatLeaf.id);
      const outerMatrix = nestedTransformSnapshot && outerCanonical
        ? transformGroupRepeatMatrices(nestedTransformSnapshot.nodes, outerCanonical)?.[0]
        : undefined;
      const innerMatrix = nestedTransformSnapshot && innerCanonical
        ? transformGroupRepeatMatrices(nestedTransformSnapshot.nodes, innerCanonical)?.[0]
        : undefined;
      const nestedTransformLeafWorld = nestedTransformSnapshot && nestedLeafCanonical
        ? worldTransformForNode(nestedTransformSnapshot.nodes, nestedLeafCanonical.id)
        : undefined;
      const nestedTransformSvg = await outerRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !outerMatrix || !innerMatrix || !nestedTransformLeafWorld
        || !nestedTransformSvg.includes('transform="matrix(1 0 0 1 300 0)"')
        || (nestedTransformSvg.match(/transform="matrix\(1 0 0 1 0 120\)"/gu)?.length ?? 0) !== 2
      ) throw new Error("Nested TransformGroup Repeat did not preserve both bounded modifier levels in the confirmed SVG.");
      append(`Nested TransformGroup Repeat fence and recursive SVG passed at revision ${nestedTransformGroupRevision}.`);

      const nestedTransformSourceCenter = transformPoint(nestedTransformLeafWorld, {
        x: nestedLeafCanonical!.width / 2,
        y: nestedLeafCanonical!.height / 2,
      });
      const nestedTransformDerivedCenter = transformPoint(outerMatrix, transformPoint(innerMatrix, nestedTransformSourceCenter));
      const nestedTransformScreen = {
        x: (nestedTransformDerivedCenter.x + nestedTransformSnapshot!.viewport.x) * nestedTransformSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (nestedTransformDerivedCenter.y + nestedTransformSnapshot!.viewport.y) * nestedTransformSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const nestedTransformHitPromise = waitForViewState(() => true, "nested TransformGroup derived deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...nestedTransformScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const nestedTransformHit = await nestedTransformHitPromise;
      if (nestedTransformHit.selectedIds[0] !== nestedRepeatLeaf.id) {
        throw new Error(`Nested TransformGroup derived hit selected ${nestedTransformHit.selectedIds.join(",") || "nothing"} instead of its source leaf.`);
      }
      if (latestSnapshotRef.current?.revision !== nestedTransformGroupRevision) throw new Error("Nested TransformGroup derived hit advanced the Canonical revision.");
      append("Nested TransformGroup composed-matrix deep-select passed without a revision.");

      const nestedTransformUndoPromise = waitForSnapshot(
        (next) => next.revision > nestedTransformGroupRevision && !next.nodes.some((node) => node.id === outerRepeat.id),
        "nested TransformGroup Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const nestedTransformUndone = await nestedTransformUndoPromise;
      if (!outerRepeat.removed || !innerRepeat.removed || !nestedRepeatLeaf.removed) {
        throw new Error("Undo did not retire the nested TransformGroup Repeat transaction atomically.");
      }
      append(`Nested TransformGroup Repeat Undo retired both groups and the source at revision ${nestedTransformUndone.revision}.`);

      const booleanOuter = runtime.createVector();
      booleanOuter.name = "Repeated Boolean outer";
      booleanOuter.x = 40;
      booleanOuter.y = 680;
      booleanOuter.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 80 0 L 80 60 L 0 60 Z" }];
      const booleanCutout = runtime.createVector();
      booleanCutout.name = "Repeated Boolean cutout";
      booleanCutout.x = 60;
      booleanCutout.y = 700;
      booleanCutout.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 40 0 L 40 20 L 0 20 Z" }];
      const repeatedBoolean = runtime.subtract(
        [booleanOuter, booleanCutout],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
      );
      repeatedBoolean.name = "Repeated Boolean source";
      const booleanSourceRevision = await runtime.commitAsync();
      if (
        latestSnapshotRef.current?.nodes.find((node) => node.id === repeatedBoolean.id)?.kind !== "booleanOperation"
        || latestSnapshotRef.current?.nodes.filter((node) => node.parentId === repeatedBoolean.id && node.kind === "vector").length !== 2
      ) throw new Error("Confirmed Boolean source did not preserve its two Vector operands.");
      append(`Boolean source fence passed at revision ${booleanSourceRevision}.`);
      const booleanRepeat = runtime.transformGroup(
        [repeatedBoolean],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      booleanRepeat.name = "Runtime repeated Boolean";
      const booleanRepeatRevision = await runtime.commitAsync();
      const booleanSnapshot = latestSnapshotRef.current;
      const booleanCanonicalGroup = booleanSnapshot?.nodes.find((node) => node.id === booleanRepeat.id);
      const booleanCanonical = booleanSnapshot?.nodes.find((node) => node.id === repeatedBoolean.id);
      const booleanMatrix = booleanSnapshot && booleanCanonicalGroup
        ? transformGroupRepeatMatrices(booleanSnapshot.nodes, booleanCanonicalGroup)?.[0]
        : undefined;
      const booleanWorld = booleanSnapshot && booleanCanonical
        ? worldTransformForNode(booleanSnapshot.nodes, booleanCanonical.id)
        : undefined;
      if (
        booleanCanonical?.kind !== "booleanOperation" || booleanCanonical.booleanOperation !== "subtract"
        || booleanSnapshot?.nodes.filter((node) => node.parentId === repeatedBoolean.id && node.kind === "vector").length !== 2
        || !booleanMatrix || !booleanWorld
      ) throw new Error(`Boolean Repeat did not preserve its derived outline inputs: kind=${booleanCanonical?.kind ?? "missing"}, operation=${booleanCanonical?.booleanOperation ?? "missing"}, operands=${booleanSnapshot?.nodes.filter((node) => node.parentId === repeatedBoolean.id && node.kind === "vector").length ?? 0}, matrix=${Boolean(booleanMatrix)}, world=${Boolean(booleanWorld)}.`);
      append(`Boolean Repeat fence and derived Canvas outline inputs passed at revision ${booleanRepeatRevision}.`);

      const booleanRepeatSvg = await booleanRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !booleanRepeatSvg.includes('<path ')
        || !booleanRepeatSvg.includes('transform="matrix(1 0 0 1 300 0)"')
        || (booleanRepeatSvg.match(/<path /gu)?.length ?? 0) !== 4
      ) throw new Error(`Live Boolean Repeat SVG did not materialize its Rust-derived source and derived copy: matrix=${booleanRepeatSvg.includes('transform="matrix(1 0 0 1 300 0)"')}, paths=${booleanRepeatSvg.match(/<path /gu)?.length ?? 0}.`);
      if (latestSnapshotRef.current?.revision !== booleanRepeatRevision) throw new Error("Live Boolean Repeat SVG export advanced the Canonical revision.");
      append("Live Boolean Repeat SVG materialized its Rust-derived source and derived copy without advancing revision.");

      const booleanInsideWorld = transformPoint(booleanMatrix, transformPoint(booleanWorld, { x: 10, y: 30 }));
      const booleanInsideScreen = {
        x: (booleanInsideWorld.x + booleanSnapshot!.viewport.x) * booleanSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (booleanInsideWorld.y + booleanSnapshot!.viewport.y) * booleanSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const booleanBoundaryPromise = waitForViewState(() => true, "derived Boolean Repeat boundary selection");
      worker.postMessage({ type: "pointer", event: "down", ...booleanInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true } satisfies MainToWorker);
      const booleanBoundary = await booleanBoundaryPromise;
      if (booleanBoundary.selectedIds[0] !== booleanRepeat.id) throw new Error("Derived Boolean Repeat did not select its TransformGroup boundary.");
      const booleanDeepPromise = waitForViewState(() => true, "derived Boolean Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...booleanInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const booleanDeep = await booleanDeepPromise;
      if (booleanDeep.selectedIds[0] !== repeatedBoolean.id) throw new Error(`Derived Boolean Repeat deep hit selected ${booleanDeep.selectedIds.join(",") || "nothing"} instead of its Boolean outline.`);
      if (latestSnapshotRef.current?.revision !== booleanRepeatRevision) throw new Error("Derived Boolean Repeat selection advanced the Canonical revision.");
      append("Boolean Repeat boundary/deep-select passed without exposing operand identities or advancing revision.");

      const booleanUndoPromise = waitForSnapshot(
        (next) => next.revision > booleanRepeatRevision
          && !next.nodes.some((node) => node.id === booleanRepeat.id)
          && next.nodes.some((node) => node.id === repeatedBoolean.id && node.parentId !== booleanRepeat.id),
        "Boolean Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const booleanUndone = await booleanUndoPromise;
      if (!booleanRepeat.removed || repeatedBoolean.removed || booleanOuter.removed || booleanCutout.removed) {
        throw new Error("Undo did not retire the Repeat wrapper while restoring the confirmed Boolean source.");
      }
      append(`Boolean Repeat Undo restored the confirmed Boolean source at revision ${booleanUndone.revision}.`);
      const booleanSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > booleanUndone.revision && !next.nodes.some((node) => node.id === repeatedBoolean.id),
        "Boolean source creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const booleanSourceUndone = await booleanSourceUndoPromise;
      if (!repeatedBoolean.removed || !booleanOuter.removed || !booleanCutout.removed) {
        throw new Error("Undo did not retire the Boolean source and operands atomically.");
      }
      append(`Boolean source Undo retired the Boolean and operands at revision ${booleanSourceUndone.revision}.`);

      const effectLeaf = runtime.createRectangle();
      effectLeaf.name = "Repeated Layer Blur source";
      effectLeaf.x = 40;
      effectLeaf.y = 100;
      effectLeaf.resize(80, 60);
      effectLeaf.fills = [{ type: "SOLID", color: { r: .9, g: .2, b: .2 } }];
      const effectSourceRevision = await runtime.commitAsync();
      const effectUpdatePromise = waitForSnapshot(
        (next) => next.revision > effectSourceRevision && Boolean(next.nodes.find((node) => node.id === effectLeaf.id)?.effectStack?.[0]?.layerBlur),
        "Repeat effect source projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: effectSourceRevision,
          commands: [{ type: "update", id: effectLeaf.id, patch: { effectStack: [{ layerBlur: { visible: true, radius: 6 } }] } }],
        },
      } satisfies MainToWorker);
      await effectUpdatePromise;
      const effectRepeat = runtime.transformGroup(
        [effectLeaf],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      effectRepeat.name = "Runtime repeated Layer Blur";
      const effectRepeatRevision = await runtime.commitAsync();
      const effectSnapshot = latestSnapshotRef.current;
      const effectCanonicalGroup = effectSnapshot?.nodes.find((node) => node.id === effectRepeat.id);
      const effectCanonicalLeaf = effectSnapshot?.nodes.find((node) => node.id === effectLeaf.id);
      const effectMatrix = effectSnapshot && effectCanonicalGroup ? transformGroupRepeatMatrices(effectSnapshot.nodes, effectCanonicalGroup)?.[0] : undefined;
      const effectWorld = effectSnapshot && effectCanonicalLeaf ? worldTransformForNode(effectSnapshot.nodes, effectCanonicalLeaf.id) : undefined;
      const effectSvg = await effectRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !effectMatrix || !effectWorld || !effectCanonicalLeaf?.effectStack?.[0]?.layerBlur
        || !effectSvg.includes("<feGaussianBlur")
        || !effectSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Standalone Layer Blur Repeat did not preserve its Worker projection, SVG filter and derived matrix.");
      const effectCanvas = await waitForFrameHash(
        (frame) => frame.revision === effectRepeatRevision,
        "standalone Layer Blur Repeat frame hash",
      );
      const effectSourcePixel = effectCanvas.samples?.find((sample) => sample.label === "repeat-effect-source-inside")?.rgba;
      const effectDerivedPixel = effectCanvas.samples?.find((sample) => sample.label === "repeat-effect-inside")?.rgba;
      if (
        !effectSourcePixel || !effectDerivedPixel
        || effectSourcePixel.some((channel, index) => channel !== effectDerivedPixel[index])
        || effectDerivedPixel[0] < 210 || effectDerivedPixel[1] > 80 || effectDerivedPixel[2] > 80
      ) throw new Error(`Standalone Layer Blur Repeat Canvas probes were wrong: source=${effectSourcePixel?.join(",") ?? "missing"}, derived=${effectDerivedPixel?.join(",") ?? "missing"}, world=${JSON.stringify(effectWorld)}, matrix=${JSON.stringify(effectMatrix)}.`);
      const effectDerivedWorld = transformPoint(effectMatrix, transformPoint(effectWorld, { x: 40, y: 30 }));
      const effectDerivedScreen = {
        x: (effectDerivedWorld.x + effectSnapshot!.viewport.x) * effectSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (effectDerivedWorld.y + effectSnapshot!.viewport.y) * effectSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const effectDeepPromise = waitForViewState(() => true, "derived Layer Blur Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...effectDerivedScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const effectDeep = await effectDeepPromise;
      if (effectDeep.selectedIds[0] !== effectLeaf.id || latestSnapshotRef.current?.revision !== effectRepeatRevision) {
        throw new Error("Standalone Layer Blur Repeat did not share the Canvas materialization and deep-hit admission contract.");
      }
      append(`Standalone Layer Blur Repeat Canvas ${effectCanvas.rgbaSha256} probes source=${effectSourcePixel.join(",")} derived=${effectDerivedPixel.join(",")}, deep-hit and SVG passed at revision ${effectRepeatRevision}.`);

      const effectRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > effectRepeatRevision && !next.nodes.some((node) => node.id === effectRepeat.id),
        "Layer Blur Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectRepeatUndone = await effectRepeatUndoPromise;
      const effectUpdateUndoPromise = waitForSnapshot(
        (next) => next.revision > effectRepeatUndone.revision && !next.nodes.find((node) => node.id === effectLeaf.id)?.effectStack?.length,
        "Layer Blur update Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectUpdateUndone = await effectUpdateUndoPromise;
      const effectSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > effectUpdateUndone.revision && !next.nodes.some((node) => node.id === effectLeaf.id),
        "Layer Blur source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectSourceUndone = await effectSourceUndoPromise;
      if (!effectRepeat.removed || !effectLeaf.removed) throw new Error("Layer Blur Repeat Undo sequence did not retire its wrapper and source.");
      append(`Standalone Layer Blur Repeat Undo sequence passed through revision ${effectSourceUndone.revision}.`);

      const repeatMask = runtime.createEllipse();
      repeatMask.name = "Repeated alpha mask";
      repeatMask.x = 40;
      repeatMask.y = 240;
      repeatMask.resize(80, 80);
      repeatMask.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      repeatMask.isMask = true;
      const maskedTarget = runtime.createRectangle();
      maskedTarget.name = "Repeated masked target";
      maskedTarget.x = 40;
      maskedTarget.y = 240;
      maskedTarget.resize(120, 80);
      maskedTarget.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
      const maskRepeat = runtime.transformGroup(
        [repeatMask, maskedTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      maskRepeat.name = "Runtime repeated alpha mask";
      const maskRepeatRevision = await runtime.commitAsync();
      const maskSnapshot = latestSnapshotRef.current;
      const maskCanonicalGroup = maskSnapshot?.nodes.find((node) => node.id === maskRepeat.id);
      const maskCanonicalSource = maskSnapshot?.nodes.find((node) => node.id === repeatMask.id);
      const maskCanonicalTarget = maskSnapshot?.nodes.find((node) => node.id === maskedTarget.id);
      const maskMatrix = maskSnapshot && maskCanonicalGroup
        ? transformGroupRepeatMatrices(maskSnapshot.nodes, maskCanonicalGroup)?.[0]
        : undefined;
      const maskTargetWorld = maskSnapshot && maskCanonicalTarget
        ? worldTransformForNode(maskSnapshot.nodes, maskCanonicalTarget.id)
        : undefined;
      const maskSvg = await maskRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !maskCanonicalSource?.isMask || !maskMatrix || !maskTargetWorld
        || (maskSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || !maskSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Alpha-mask Repeat did not preserve SetMask, derived SVG masks and its matrix.");
      const maskFrame = await waitForFrameHash((frame) => frame.revision === maskRepeatRevision, "alpha-mask Repeat frame hash");
      const insidePixel = maskFrame.samples?.find((sample) => sample.label === "repeat-mask-inside")?.rgba;
      const outsidePixel = maskFrame.samples?.find((sample) => sample.label === "repeat-mask-outside")?.rgba;
      if (!insidePixel || insidePixel[0] < 240 || insidePixel[1] > 16 || insidePixel[2] > 16 || !outsidePixel || (outsidePixel[0] > 240 && outsidePixel[1] < 16 && outsidePixel[2] < 16)) {
        throw new Error(`Alpha-mask Repeat Canvas probes were wrong: inside=${insidePixel?.join(",") ?? "missing"}, outside=${outsidePixel?.join(",") ?? "missing"}.`);
      }

      const maskInsideWorld = transformPoint(maskMatrix, transformPoint(maskTargetWorld, { x: 40, y: 40 }));
      const maskInsideScreen = {
        x: (maskInsideWorld.x + maskSnapshot!.viewport.x) * maskSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (maskInsideWorld.y + maskSnapshot!.viewport.y) * maskSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const maskDeepPromise = waitForViewState(() => true, "derived masked Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...maskInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const maskDeep = await maskDeepPromise;
      if (maskDeep.selectedIds[0] !== maskedTarget.id) throw new Error("Derived alpha-mask Repeat did not resolve its visible target identity.");
      const maskOutsideWorld = transformPoint(maskMatrix, transformPoint(maskTargetWorld, { x: 110, y: 40 }));
      const maskOutsideScreen = {
        x: (maskOutsideWorld.x + maskSnapshot!.viewport.x) * maskSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (maskOutsideWorld.y + maskSnapshot!.viewport.y) * maskSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const maskOutsidePromise = waitForViewState(() => true, "derived masked Repeat alpha rejection");
      worker.postMessage({ type: "pointer", event: "down", ...maskOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const maskOutside = await maskOutsidePromise;
      if (maskOutside.selectedIds.includes(maskedTarget.id) || latestSnapshotRef.current?.revision !== maskRepeatRevision) {
        throw new Error("Derived alpha-mask Repeat exposed a target outside source alpha or advanced revision.");
      }
      append(`Alpha-mask Repeat Canvas ${maskFrame.rgbaSha256} probes inside=${insidePixel.join(",")} outside=${outsidePixel.join(",")}, deep-hit, SVG and Runtime SetMask passed at revision ${maskRepeatRevision}.`);

      const maskUndoPromise = waitForSnapshot(
        (next) => next.revision > maskRepeatRevision && !next.nodes.some((node) => node.id === maskRepeat.id || node.id === repeatMask.id || node.id === maskedTarget.id),
        "alpha-mask Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const maskUndone = await maskUndoPromise;
      if (!maskRepeat.removed || !repeatMask.removed || !maskedTarget.removed) throw new Error("Alpha-mask Repeat Undo did not retire its wrapper and sources atomically.");
      append(`Alpha-mask Repeat Undo retired the complete transaction at revision ${maskUndone.revision}.`);

      const nestedMask = runtime.createEllipse();
      nestedMask.name = "Nested Repeat alpha mask";
      nestedMask.x = 40;
      nestedMask.y = 400;
      nestedMask.resize(60, 60);
      nestedMask.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      nestedMask.isMask = true;
      const nestedMaskedTarget = runtime.createRectangle();
      nestedMaskedTarget.name = "Nested Repeat masked target";
      nestedMaskedTarget.x = 40;
      nestedMaskedTarget.y = 400;
      nestedMaskedTarget.resize(100, 60);
      nestedMaskedTarget.fills = [{ type: "SOLID", color: { r: 0, g: 0.5, b: 1 } }];
      const innerMaskedRepeat = runtime.transformGroup(
        [nestedMask, nestedMaskedTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 100, axis: "VERTICAL" }],
      );
      innerMaskedRepeat.name = "Inner masked Repeat";
      const outerMaskedRepeat = runtime.transformGroup(
        [innerMaskedRepeat],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      outerMaskedRepeat.name = "Outer masked Repeat";
      const nestedMaskRevision = await runtime.commitAsync();
      const nestedMaskSnapshot = latestSnapshotRef.current;
      const outerMaskCanonical = nestedMaskSnapshot?.nodes.find((node) => node.id === outerMaskedRepeat.id);
      const innerMaskCanonical = nestedMaskSnapshot?.nodes.find((node) => node.id === innerMaskedRepeat.id);
      const nestedTargetCanonical = nestedMaskSnapshot?.nodes.find((node) => node.id === nestedMaskedTarget.id);
      const outerMaskMatrix = nestedMaskSnapshot && outerMaskCanonical ? transformGroupRepeatMatrices(nestedMaskSnapshot.nodes, outerMaskCanonical)?.[0] : undefined;
      const innerMaskMatrix = nestedMaskSnapshot && innerMaskCanonical ? transformGroupRepeatMatrices(nestedMaskSnapshot.nodes, innerMaskCanonical)?.[0] : undefined;
      const nestedTargetWorld = nestedMaskSnapshot && nestedTargetCanonical ? worldTransformForNode(nestedMaskSnapshot.nodes, nestedTargetCanonical.id) : undefined;
      const nestedMaskSvg = await outerMaskedRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !nestedMaskSnapshot?.nodes.find((node) => node.id === nestedMask.id)?.isMask
        || !outerMaskMatrix || !innerMaskMatrix || !nestedTargetWorld
        || (nestedMaskSvg.match(/<mask /gu)?.length ?? 0) !== 4
        || (nestedMaskSvg.match(/transform="matrix\(1 0 0 1 0 100\)"/gu)?.length ?? 0) !== 2
        || !nestedMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Nested masked Repeat did not preserve both matrix levels and four source-alpha SVG occurrences.");
      const nestedMaskFrame = await waitForFrameHash((frame) => frame.revision === nestedMaskRevision, "nested masked Repeat frame hash");
      const nestedInsidePixel = nestedMaskFrame.samples?.find((sample) => sample.label === "nested-repeat-mask-inside")?.rgba;
      const nestedOutsidePixel = nestedMaskFrame.samples?.find((sample) => sample.label === "nested-repeat-mask-outside")?.rgba;
      if (!nestedInsidePixel || nestedInsidePixel[2] < 240 || nestedInsidePixel[1] < 110 || !nestedOutsidePixel || (nestedOutsidePixel[2] > 240 && nestedOutsidePixel[1] > 110)) {
        throw new Error(`Nested masked Repeat Canvas probes were wrong: inside=${nestedInsidePixel?.join(",") ?? "missing"}, outside=${nestedOutsidePixel?.join(",") ?? "missing"}.`);
      }
      const nestedMaskInsideWorld = transformPoint(outerMaskMatrix, transformPoint(innerMaskMatrix, transformPoint(nestedTargetWorld, { x: 30, y: 30 })));
      const nestedMaskInsideScreen = {
        x: (nestedMaskInsideWorld.x + nestedMaskSnapshot.viewport.x) * nestedMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (nestedMaskInsideWorld.y + nestedMaskSnapshot.viewport.y) * nestedMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const nestedMaskHitPromise = waitForViewState(() => true, "nested masked Repeat composed deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...nestedMaskInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const nestedMaskHit = await nestedMaskHitPromise;
      if (nestedMaskHit.selectedIds[0] !== nestedMaskedTarget.id) throw new Error("Nested masked Repeat did not resolve the target through both inverse matrices and source alpha.");
      const nestedMaskOutsideWorld = transformPoint(outerMaskMatrix, transformPoint(innerMaskMatrix, transformPoint(nestedTargetWorld, { x: 90, y: 30 })));
      const nestedMaskOutsideScreen = {
        x: (nestedMaskOutsideWorld.x + nestedMaskSnapshot.viewport.x) * nestedMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (nestedMaskOutsideWorld.y + nestedMaskSnapshot.viewport.y) * nestedMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const nestedMaskOutsidePromise = waitForViewState(() => true, "nested masked Repeat composed alpha rejection");
      worker.postMessage({ type: "pointer", event: "down", ...nestedMaskOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const nestedMaskOutside = await nestedMaskOutsidePromise;
      if (nestedMaskOutside.selectedIds.includes(nestedMaskedTarget.id) || latestSnapshotRef.current?.revision !== nestedMaskRevision) {
        throw new Error("Nested masked Repeat exposed a target outside inner source alpha or advanced revision.");
      }
      append(`Nested masked Repeat Canvas ${nestedMaskFrame.rgbaSha256} probes inside=${nestedInsidePixel.join(",")} outside=${nestedOutsidePixel.join(",")}, composed deep-hit and four-mask SVG passed at revision ${nestedMaskRevision}.`);

      const nestedMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > nestedMaskRevision && !next.nodes.some((node) => [outerMaskedRepeat.id, innerMaskedRepeat.id, nestedMask.id, nestedMaskedTarget.id].includes(node.id)),
        "nested masked Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const nestedMaskUndone = await nestedMaskUndoPromise;
      if (!outerMaskedRepeat.removed || !innerMaskedRepeat.removed || !nestedMask.removed || !nestedMaskedTarget.removed) {
        throw new Error("Nested masked Repeat Undo did not retire both wrappers and source nodes atomically.");
      }
      append(`Nested masked Repeat Undo retired both wrappers and sources at revision ${nestedMaskUndone.revision}.`);

      const frameMask = runtime.createFrame();
      frameMask.name = "Repeat descendant-owning Frame mask";
      frameMask.x = 40;
      frameMask.y = 480;
      frameMask.resize(100, 80);
      frameMask.fills = [];
      frameMask.isMask = true;
      const frameMaskChild = runtime.createEllipse();
      frameMaskChild.name = "Frame mask alpha child";
      frameMaskChild.x = 60;
      frameMaskChild.y = 500;
      frameMaskChild.resize(40, 40);
      frameMaskChild.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      frameMask.appendChild(frameMaskChild);
      const frameMaskedTarget = runtime.createRectangle();
      frameMaskedTarget.name = "Frame-mask Repeat target";
      frameMaskedTarget.x = 40;
      frameMaskedTarget.y = 480;
      frameMaskedTarget.resize(100, 80);
      frameMaskedTarget.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.8, b: 0.3 } }];
      const frameMaskRepeat = runtime.transformGroup(
        [frameMask, frameMaskedTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      frameMaskRepeat.name = "Descendant-owning mask Repeat";
      const frameMaskRevision = await runtime.commitAsync();
      const frameMaskSnapshot = latestSnapshotRef.current;
      const frameMaskRepeatCanonical = frameMaskSnapshot?.nodes.find((node) => node.id === frameMaskRepeat.id);
      const frameMaskTargetCanonical = frameMaskSnapshot?.nodes.find((node) => node.id === frameMaskedTarget.id);
      const frameMaskMatrix = frameMaskSnapshot && frameMaskRepeatCanonical ? transformGroupRepeatMatrices(frameMaskSnapshot.nodes, frameMaskRepeatCanonical)?.[0] : undefined;
      const frameMaskTargetWorld = frameMaskSnapshot && frameMaskTargetCanonical ? worldTransformForNode(frameMaskSnapshot.nodes, frameMaskTargetCanonical.id) : undefined;
      const frameMaskSvg = await frameMaskRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !frameMaskSnapshot?.nodes.find((node) => node.id === frameMask.id)?.isMask
        || !frameMaskMatrix || !frameMaskTargetWorld
        || (frameMaskSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || (frameMaskSvg.match(/<ellipse /gu)?.length ?? 0) !== 2
        || !frameMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Descendant-owning Frame mask Repeat did not preserve its child alpha in source and derived SVG masks.");
      const frameMaskCanvas = await waitForFrameHash((frame) => frame.revision === frameMaskRevision, "descendant-owning Frame mask Repeat frame hash");
      const frameMaskInsidePixel = frameMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-inside")?.rgba;
      const frameMaskOutsidePixel = frameMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-outside")?.rgba;
      const frameMaskSourceInsidePixel = frameMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-inside")?.rgba;
      const frameMaskSourceOutsidePixel = frameMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-outside")?.rgba;
      if (
        !frameMaskInsidePixel || frameMaskInsidePixel[1] < 190 || frameMaskInsidePixel[0] > 70
        || !frameMaskOutsidePixel || (frameMaskOutsidePixel[1] > 190 && frameMaskOutsidePixel[0] < 70)
        || !frameMaskSourceInsidePixel || frameMaskSourceInsidePixel[1] < 190 || frameMaskSourceInsidePixel[0] > 70
        || !frameMaskSourceOutsidePixel || (frameMaskSourceOutsidePixel[1] > 190 && frameMaskSourceOutsidePixel[0] < 70)
      ) {
        throw new Error(`Descendant-owning Frame mask Canvas probes were wrong: derived=${frameMaskInsidePixel?.join(",") ?? "missing"}/${frameMaskOutsidePixel?.join(",") ?? "missing"}, source=${frameMaskSourceInsidePixel?.join(",") ?? "missing"}/${frameMaskSourceOutsidePixel?.join(",") ?? "missing"}.`);
      }
      const frameMaskInsideWorld = transformPoint(frameMaskMatrix, transformPoint(frameMaskTargetWorld, { x: 40, y: 40 }));
      const frameMaskInsideScreen = {
        x: (frameMaskInsideWorld.x + frameMaskSnapshot.viewport.x) * frameMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (frameMaskInsideWorld.y + frameMaskSnapshot.viewport.y) * frameMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const frameMaskHitPromise = waitForViewState(() => true, "descendant-owning Frame mask Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...frameMaskInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const frameMaskHit = await frameMaskHitPromise;
      if (frameMaskHit.selectedIds[0] !== frameMaskedTarget.id) throw new Error("Descendant-owning Frame mask Repeat did not resolve its canonical target inside child alpha.");
      const frameMaskOutsideWorld = transformPoint(frameMaskMatrix, transformPoint(frameMaskTargetWorld, { x: 90, y: 40 }));
      const frameMaskOutsideScreen = {
        x: (frameMaskOutsideWorld.x + frameMaskSnapshot.viewport.x) * frameMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (frameMaskOutsideWorld.y + frameMaskSnapshot.viewport.y) * frameMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const frameMaskOutsidePromise = waitForViewState(() => true, "descendant-owning Frame mask Repeat alpha rejection");
      worker.postMessage({ type: "pointer", event: "down", ...frameMaskOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const frameMaskOutside = await frameMaskOutsidePromise;
      if (frameMaskOutside.selectedIds.includes(frameMaskedTarget.id) || latestSnapshotRef.current?.revision !== frameMaskRevision) {
        throw new Error("Descendant-owning Frame mask Repeat exposed its target outside child alpha or advanced revision.");
      }
      append(`Descendant-owning Frame mask Repeat Canvas ${frameMaskCanvas.rgbaSha256} probes derived=${frameMaskInsidePixel.join(",")}/${frameMaskOutsidePixel.join(",")} source=${frameMaskSourceInsidePixel.join(",")}/${frameMaskSourceOutsidePixel.join(",")}, deep-hit and two-mask SVG passed at revision ${frameMaskRevision}.`);

      const frameMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > frameMaskRevision && !next.nodes.some((node) => [frameMaskRepeat.id, frameMask.id, frameMaskChild.id, frameMaskedTarget.id].includes(node.id)),
        "descendant-owning Frame mask Repeat creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const frameMaskUndone = await frameMaskUndoPromise;
      if (!frameMaskRepeat.removed || !frameMask.removed || !frameMaskChild.removed || !frameMaskedTarget.removed) {
        throw new Error("Descendant-owning Frame mask Repeat Undo did not retire its wrapper and full source subtree atomically.");
      }
      append(`Descendant-owning Frame mask Repeat Undo retired wrapper, mask subtree and target at revision ${frameMaskUndone.revision}.`);

      const groupMask = runtime.createGroup();
      groupMask.name = "Repeat descendant-owning Group mask";
      groupMask.x = 40;
      groupMask.y = 480;
      groupMask.resize(100, 80);
      const groupMaskChild = runtime.createEllipse();
      groupMaskChild.name = "Group mask alpha child";
      groupMaskChild.x = 60;
      groupMaskChild.y = 500;
      groupMaskChild.resize(40, 40);
      groupMaskChild.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      groupMask.appendChild(groupMaskChild);
      const groupMaskedTarget = runtime.createRectangle();
      groupMaskedTarget.name = "Group-mask Repeat target";
      groupMaskedTarget.x = 40;
      groupMaskedTarget.y = 480;
      groupMaskedTarget.resize(100, 80);
      groupMaskedTarget.fills = [{ type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.5 } }];
      const groupMaskSourceRevision = await runtime.commitAsync();
      const groupMaskSourceSnapshot = latestSnapshotRef.current;
      const groupMaskChildCount = groupMaskSourceSnapshot?.nodes.filter((node) => node.parentId === groupMask.id).length ?? 0;
      if (groupMaskChildCount !== 1) throw new Error("Descendant-owning Group mask source subtree did not preserve its child through the first transaction fence.");
      append(`Descendant-owning Group mask source subtree committed at revision ${groupMaskSourceRevision}.`);
      groupMask.isMask = true;
      const groupMaskSetRevision = await runtime.commitAsync();
      if (!latestSnapshotRef.current?.nodes.find((node) => node.id === groupMask.id)?.isMask) {
        throw new Error("Descendant-owning Group mask did not survive the dedicated Runtime SetMask transaction.");
      }
      append(`Descendant-owning Group mask Runtime SetMask passed at revision ${groupMaskSetRevision}.`);
      const groupMaskRepeat = runtime.transformGroup(
        [groupMask, groupMaskedTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      groupMaskRepeat.name = "Group-mask Repeat";
      const groupMaskRevision = await runtime.commitAsync();
      const groupMaskSnapshot = latestSnapshotRef.current;
      const groupMaskRepeatCanonical = groupMaskSnapshot?.nodes.find((node) => node.id === groupMaskRepeat.id);
      const groupMaskTargetCanonical = groupMaskSnapshot?.nodes.find((node) => node.id === groupMaskedTarget.id);
      const groupMaskMatrix = groupMaskSnapshot && groupMaskRepeatCanonical ? transformGroupRepeatMatrices(groupMaskSnapshot.nodes, groupMaskRepeatCanonical)?.[0] : undefined;
      const groupMaskTargetWorld = groupMaskSnapshot && groupMaskTargetCanonical ? worldTransformForNode(groupMaskSnapshot.nodes, groupMaskTargetCanonical.id) : undefined;
      const groupMaskSvg = await groupMaskRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !groupMaskSnapshot?.nodes.find((node) => node.id === groupMask.id)?.isMask
        || !groupMaskMatrix || !groupMaskTargetWorld
        || (groupMaskSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || (groupMaskSvg.match(/<ellipse /gu)?.length ?? 0) !== 2
        || !groupMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Descendant-owning Group mask Repeat did not preserve its child alpha in source and derived SVG masks.");
      const groupMaskCanvas = await waitForFrameHash((frame) => frame.revision === groupMaskRevision, "descendant-owning Group mask Repeat frame hash");
      const groupMaskInsidePixel = groupMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-inside")?.rgba;
      const groupMaskOutsidePixel = groupMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-outside")?.rgba;
      const groupMaskSourceInsidePixel = groupMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-inside")?.rgba;
      const groupMaskSourceOutsidePixel = groupMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-outside")?.rgba;
      if (
        !groupMaskInsidePixel || groupMaskInsidePixel[0] < 190 || groupMaskInsidePixel[1] > 70
        || !groupMaskOutsidePixel || (groupMaskOutsidePixel[0] > 190 && groupMaskOutsidePixel[1] < 70)
        || !groupMaskSourceInsidePixel || groupMaskSourceInsidePixel[0] < 190 || groupMaskSourceInsidePixel[1] > 70
        || !groupMaskSourceOutsidePixel || (groupMaskSourceOutsidePixel[0] > 190 && groupMaskSourceOutsidePixel[1] < 70)
      ) {
        throw new Error(`Descendant-owning Group mask Canvas probes were wrong: derived=${groupMaskInsidePixel?.join(",") ?? "missing"}/${groupMaskOutsidePixel?.join(",") ?? "missing"}, source=${groupMaskSourceInsidePixel?.join(",") ?? "missing"}/${groupMaskSourceOutsidePixel?.join(",") ?? "missing"}.`);
      }
      const groupMaskInsideWorld = transformPoint(groupMaskMatrix, transformPoint(groupMaskTargetWorld, { x: 40, y: 40 }));
      const groupMaskInsideScreen = {
        x: (groupMaskInsideWorld.x + groupMaskSnapshot.viewport.x) * groupMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (groupMaskInsideWorld.y + groupMaskSnapshot.viewport.y) * groupMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const groupMaskHitPromise = waitForViewState(() => true, "descendant-owning Group mask Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...groupMaskInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const groupMaskHit = await groupMaskHitPromise;
      if (groupMaskHit.selectedIds[0] !== groupMaskedTarget.id) throw new Error("Descendant-owning Group mask Repeat did not resolve its canonical target inside child alpha.");
      const groupMaskOutsideWorld = transformPoint(groupMaskMatrix, transformPoint(groupMaskTargetWorld, { x: 90, y: 40 }));
      const groupMaskOutsideScreen = {
        x: (groupMaskOutsideWorld.x + groupMaskSnapshot.viewport.x) * groupMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (groupMaskOutsideWorld.y + groupMaskSnapshot.viewport.y) * groupMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const groupMaskOutsidePromise = waitForViewState(() => true, "descendant-owning Group mask Repeat alpha rejection");
      worker.postMessage({ type: "pointer", event: "down", ...groupMaskOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const groupMaskOutside = await groupMaskOutsidePromise;
      if (groupMaskOutside.selectedIds.includes(groupMaskedTarget.id) || latestSnapshotRef.current?.revision !== groupMaskRevision) {
        throw new Error("Descendant-owning Group mask Repeat exposed its target outside child alpha or advanced revision.");
      }
      append(`Descendant-owning Group mask Repeat Canvas ${groupMaskCanvas.rgbaSha256} probes derived=${groupMaskInsidePixel.join(",")}/${groupMaskOutsidePixel.join(",")} source=${groupMaskSourceInsidePixel.join(",")}/${groupMaskSourceOutsidePixel.join(",")}, deep-hit and two-mask SVG passed at revision ${groupMaskRevision}.`);

      const groupMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > groupMaskRevision && !next.nodes.some((node) => node.id === groupMaskRepeat.id),
        "descendant-owning Group mask Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const groupMaskUndone = await groupMaskUndoPromise;
      if (!groupMaskRepeat.removed || groupMask.removed || groupMaskChild.removed || groupMaskedTarget.removed || !groupMask.isMask) {
        throw new Error("Descendant-owning Group mask Repeat Undo did not restore the masked source subtree.");
      }
      append(`Descendant-owning Group mask Repeat Undo retired the wrapper and restored the masked source subtree at revision ${groupMaskUndone.revision}.`);
      const groupMaskSetUndoPromise = waitForSnapshot(
        (next) => next.revision > groupMaskUndone.revision && !next.nodes.find((node) => node.id === groupMask.id)?.isMask,
        "descendant-owning Group mask SetMask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const groupMaskSetUndone = await groupMaskSetUndoPromise;
      if (groupMask.removed || groupMaskChild.removed || groupMaskedTarget.removed || groupMask.isMask) {
        throw new Error("Descendant-owning Group mask SetMask Undo did not restore the unmasked source subtree.");
      }
      append(`Descendant-owning Group mask SetMask Undo restored the unmasked source subtree at revision ${groupMaskSetUndone.revision}.`);
      const groupMaskSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > groupMaskSetUndone.revision && !next.nodes.some((node) => [groupMask.id, groupMaskChild.id, groupMaskedTarget.id].includes(node.id)),
        "descendant-owning Group mask source creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const groupMaskSourceUndone = await groupMaskSourceUndoPromise;
      if (!groupMask.removed || !groupMaskChild.removed || !groupMaskedTarget.removed || groupMaskSourceRevision >= groupMaskSetRevision || groupMaskSetRevision >= groupMaskRevision) {
        throw new Error("Descendant-owning Group mask source Undo did not retire the complete source subtree.");
      }
      append(`Descendant-owning Group mask source Undo retired the complete subtree at revision ${groupMaskSourceUndone.revision}.`);

      const booleanMaskOuter = runtime.createVector();
      booleanMaskOuter.name = "Boolean mask outer";
      booleanMaskOuter.x = 40;
      booleanMaskOuter.y = 480;
      booleanMaskOuter.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 100 0 L 100 80 L 0 80 Z" }];
      const booleanMaskCutout = runtime.createVector();
      booleanMaskCutout.name = "Boolean mask cutout";
      booleanMaskCutout.x = 70;
      booleanMaskCutout.y = 500;
      booleanMaskCutout.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L 40 0 L 40 40 L 0 40 Z" }];
      const booleanMask = runtime.subtract(
        [booleanMaskOuter, booleanMaskCutout],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
      );
      booleanMask.name = "Repeat live Boolean mask";
      const booleanMaskedTarget = runtime.createRectangle();
      booleanMaskedTarget.name = "Boolean-mask Repeat target";
      booleanMaskedTarget.x = 40;
      booleanMaskedTarget.y = 480;
      booleanMaskedTarget.resize(100, 80);
      booleanMaskedTarget.fills = [{ type: "SOLID", color: { r: 0.08, g: 0.7, b: 0.62 } }];
      const booleanMaskSourceRevision = await runtime.commitAsync();
      if (
        latestSnapshotRef.current?.nodes.find((node) => node.id === booleanMask.id)?.kind !== "booleanOperation"
        || latestSnapshotRef.current?.nodes.filter((node) => node.parentId === booleanMask.id && node.kind === "vector").length !== 2
      ) throw new Error("Live Boolean mask source did not preserve its two canonical Vector operands.");
      append(`Live Boolean mask source committed at revision ${booleanMaskSourceRevision}.`);
      booleanMask.isMask = true;
      const booleanMaskSetRevision = await runtime.commitAsync();
      if (!latestSnapshotRef.current?.nodes.find((node) => node.id === booleanMask.id)?.isMask) {
        throw new Error("Live Boolean mask did not survive the dedicated Runtime SetMask transaction.");
      }
      append(`Live Boolean Runtime SetMask passed at revision ${booleanMaskSetRevision}.`);
      const booleanMaskRepeat = runtime.transformGroup(
        [booleanMask, booleanMaskedTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      booleanMaskRepeat.name = "Boolean-mask Repeat";
      const booleanMaskRevision = await runtime.commitAsync();
      const booleanMaskSnapshot = latestSnapshotRef.current;
      const booleanMaskRepeatCanonical = booleanMaskSnapshot?.nodes.find((node) => node.id === booleanMaskRepeat.id);
      const booleanMaskTargetCanonical = booleanMaskSnapshot?.nodes.find((node) => node.id === booleanMaskedTarget.id);
      const booleanMaskMatrix = booleanMaskSnapshot && booleanMaskRepeatCanonical ? transformGroupRepeatMatrices(booleanMaskSnapshot.nodes, booleanMaskRepeatCanonical)?.[0] : undefined;
      const booleanMaskTargetWorld = booleanMaskSnapshot && booleanMaskTargetCanonical ? worldTransformForNode(booleanMaskSnapshot.nodes, booleanMaskTargetCanonical.id) : undefined;
      const booleanMaskSvg = await booleanMaskRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !booleanMaskSnapshot?.nodes.find((node) => node.id === booleanMask.id)?.isMask
        || !booleanMaskMatrix || !booleanMaskTargetWorld
        || (booleanMaskSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || (booleanMaskSvg.match(/<path /gu)?.length ?? 0) !== 6
        || !booleanMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error(`Live Boolean mask Repeat SVG mismatch: masks=${booleanMaskSvg.match(/<mask /gu)?.length ?? 0}, paths=${booleanMaskSvg.match(/<path /gu)?.length ?? 0}, repeatMatrix=${booleanMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')}.`);
      const booleanMaskCanvas = await waitForFrameHash((frame) => frame.revision === booleanMaskRevision, "live Boolean mask Repeat frame hash");
      const booleanMaskInsidePixel = booleanMaskCanvas.samples?.find((sample) => sample.label === "repeat-boolean-mask-inside")?.rgba;
      const booleanMaskHolePixel = booleanMaskCanvas.samples?.find((sample) => sample.label === "repeat-boolean-mask-hole")?.rgba;
      const booleanMaskSourceInsidePixel = booleanMaskCanvas.samples?.find((sample) => sample.label === "repeat-boolean-mask-source-inside")?.rgba;
      const booleanMaskSourceHolePixel = booleanMaskCanvas.samples?.find((sample) => sample.label === "repeat-boolean-mask-source-hole")?.rgba;
      const isBooleanMaskTargetPixel = (pixel: readonly number[] | undefined) => Boolean(pixel && pixel[1] > 150 && pixel[2] > 120 && pixel[0] < 80);
      if (
        !isBooleanMaskTargetPixel(booleanMaskInsidePixel) || isBooleanMaskTargetPixel(booleanMaskHolePixel)
        || !isBooleanMaskTargetPixel(booleanMaskSourceInsidePixel) || isBooleanMaskTargetPixel(booleanMaskSourceHolePixel)
      ) {
        throw new Error(`Live Boolean mask Canvas probes were wrong: derived=${booleanMaskInsidePixel?.join(",") ?? "missing"}/${booleanMaskHolePixel?.join(",") ?? "missing"}, source=${booleanMaskSourceInsidePixel?.join(",") ?? "missing"}/${booleanMaskSourceHolePixel?.join(",") ?? "missing"}.`);
      }
      const booleanMaskInsideWorld = transformPoint(booleanMaskMatrix, transformPoint(booleanMaskTargetWorld, { x: 10, y: 40 }));
      const booleanMaskInsideScreen = {
        x: (booleanMaskInsideWorld.x + booleanMaskSnapshot.viewport.x) * booleanMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (booleanMaskInsideWorld.y + booleanMaskSnapshot.viewport.y) * booleanMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const booleanMaskHitPromise = waitForViewState(() => true, "live Boolean mask Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...booleanMaskInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const booleanMaskHit = await booleanMaskHitPromise;
      if (booleanMaskHit.selectedIds[0] !== booleanMaskedTarget.id) throw new Error("Live Boolean mask Repeat did not resolve its canonical target inside the Boolean outline.");
      const booleanMaskHoleWorld = transformPoint(booleanMaskMatrix, transformPoint(booleanMaskTargetWorld, { x: 50, y: 40 }));
      const booleanMaskHoleScreen = {
        x: (booleanMaskHoleWorld.x + booleanMaskSnapshot.viewport.x) * booleanMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (booleanMaskHoleWorld.y + booleanMaskSnapshot.viewport.y) * booleanMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const booleanMaskHolePromise = waitForViewState(() => true, "live Boolean mask Repeat alpha-hole rejection");
      worker.postMessage({ type: "pointer", event: "down", ...booleanMaskHoleScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const booleanMaskHole = await booleanMaskHolePromise;
      if (booleanMaskHole.selectedIds.includes(booleanMaskedTarget.id) || latestSnapshotRef.current?.revision !== booleanMaskRevision) {
        throw new Error("Live Boolean mask Repeat exposed its target through the Boolean cutout or advanced revision.");
      }
      append(`Live Boolean mask Repeat Canvas ${booleanMaskCanvas.rgbaSha256} probes derived=${booleanMaskInsidePixel!.join(",")}/${booleanMaskHolePixel!.join(",")} source=${booleanMaskSourceInsidePixel!.join(",")}/${booleanMaskSourceHolePixel!.join(",")}, deep-hit and two-mask SVG passed at revision ${booleanMaskRevision}.`);

      const booleanMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > booleanMaskRevision && !next.nodes.some((node) => node.id === booleanMaskRepeat.id),
        "live Boolean mask Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const booleanMaskUndone = await booleanMaskUndoPromise;
      if (!booleanMaskRepeat.removed || booleanMask.removed || booleanMaskOuter.removed || booleanMaskCutout.removed || booleanMaskedTarget.removed || !booleanMask.isMask) {
        throw new Error("Live Boolean mask Repeat Undo did not restore the masked source subtree.");
      }
      append(`Live Boolean mask Repeat Undo retired the wrapper and restored the masked source at revision ${booleanMaskUndone.revision}.`);
      const booleanMaskSetUndoPromise = waitForSnapshot(
        (next) => next.revision > booleanMaskUndone.revision && !next.nodes.find((node) => node.id === booleanMask.id)?.isMask,
        "live Boolean mask SetMask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const booleanMaskSetUndone = await booleanMaskSetUndoPromise;
      if (booleanMask.removed || booleanMaskOuter.removed || booleanMaskCutout.removed || booleanMaskedTarget.removed || booleanMask.isMask) {
        throw new Error("Live Boolean mask SetMask Undo did not restore the unmasked source.");
      }
      append(`Live Boolean mask SetMask Undo restored the unmasked source at revision ${booleanMaskSetUndone.revision}.`);
      const booleanMaskSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > booleanMaskSetUndone.revision && !next.nodes.some((node) => [booleanMask.id, booleanMaskOuter.id, booleanMaskCutout.id, booleanMaskedTarget.id].includes(node.id)),
        "live Boolean mask source creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const booleanMaskSourceUndone = await booleanMaskSourceUndoPromise;
      if (!booleanMask.removed || !booleanMaskOuter.removed || !booleanMaskCutout.removed || !booleanMaskedTarget.removed || booleanMaskSourceRevision >= booleanMaskSetRevision || booleanMaskSetRevision >= booleanMaskRevision) {
        throw new Error("Live Boolean mask source Undo did not retire the complete source subtree.");
      }
      append(`Live Boolean mask source Undo retired the complete subtree at revision ${booleanMaskSourceUndone.revision}.`);

      const transformMaskLeaf = runtime.createEllipse();
      transformMaskLeaf.name = "TransformGroup mask alpha source";
      transformMaskLeaf.x = 60;
      transformMaskLeaf.y = 500;
      transformMaskLeaf.resize(40, 40);
      transformMaskLeaf.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      transformMaskLeaf.strokes = [];
      const transformMask = runtime.transformGroup(
        [transformMaskLeaf],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 40, axis: "VERTICAL" }],
      );
      transformMask.name = "Repeated TransformGroup mask";
      const transformMaskedTarget = runtime.createRectangle();
      transformMaskedTarget.name = "TransformGroup-mask Repeat target";
      transformMaskedTarget.x = 40;
      transformMaskedTarget.y = 480;
      transformMaskedTarget.resize(100, 100);
      transformMaskedTarget.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.55, b: 0.12 } }];
      transformMaskedTarget.strokes = [];
      const transformMaskSourceRevision = await runtime.commitAsync();
      if (
        latestSnapshotRef.current?.nodes.find((node) => node.id === transformMask.id)?.kind !== "transformGroup"
        || latestSnapshotRef.current?.nodes.find((node) => node.id === transformMaskLeaf.id)?.parentId !== transformMask.id
      ) throw new Error("TransformGroup mask source did not preserve its repeated alpha child through the first transaction fence.");
      append(`TransformGroup mask source subtree committed at revision ${transformMaskSourceRevision}.`);
      transformMask.isMask = true;
      const transformMaskSetRevision = await runtime.commitAsync();
      if (!latestSnapshotRef.current?.nodes.find((node) => node.id === transformMask.id)?.isMask) {
        throw new Error("TransformGroup mask did not survive the dedicated Runtime SetMask transaction.");
      }
      append(`TransformGroup Runtime SetMask passed at revision ${transformMaskSetRevision}.`);
      const transformMaskOuterRepeat = runtime.transformGroup(
        [transformMask, transformMaskedTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      transformMaskOuterRepeat.name = "TransformGroup-mask outer Repeat";
      const transformMaskRevision = await runtime.commitAsync();
      const transformMaskSnapshot = latestSnapshotRef.current;
      const transformMaskOuterCanonical = transformMaskSnapshot?.nodes.find((node) => node.id === transformMaskOuterRepeat.id);
      const transformMaskTargetCanonical = transformMaskSnapshot?.nodes.find((node) => node.id === transformMaskedTarget.id);
      const transformMaskMatrix = transformMaskSnapshot && transformMaskOuterCanonical ? transformGroupRepeatMatrices(transformMaskSnapshot.nodes, transformMaskOuterCanonical)?.[0] : undefined;
      const transformMaskTargetWorld = transformMaskSnapshot && transformMaskTargetCanonical ? worldTransformForNode(transformMaskSnapshot.nodes, transformMaskTargetCanonical.id) : undefined;
      const transformMaskSvg = await transformMaskOuterRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !transformMaskSnapshot?.nodes.find((node) => node.id === transformMask.id)?.isMask
        || !transformMaskMatrix || !transformMaskTargetWorld
        || (transformMaskSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || (transformMaskSvg.match(/<ellipse /gu)?.length ?? 0) !== 4
        || (transformMaskSvg.match(/transform="matrix\(1 0 0 1 0 40\)"/gu)?.length ?? 0) !== 2
        || !transformMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error(`TransformGroup mask Repeat SVG mismatch: masks=${transformMaskSvg.match(/<mask /gu)?.length ?? 0}, ellipses=${transformMaskSvg.match(/<ellipse /gu)?.length ?? 0}, inner=${transformMaskSvg.match(/transform="matrix\(1 0 0 1 0 40\)"/gu)?.length ?? 0}, outer=${transformMaskSvg.includes('transform="matrix(1 0 0 1 300 0)"')}.`);
      const transformMaskCanvas = await waitForFrameHash((frame) => frame.revision === transformMaskRevision, "TransformGroup mask Repeat frame hash");
      const transformMaskInsidePixel = transformMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-inside")?.rgba;
      const transformMaskOutsidePixel = transformMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-outside")?.rgba;
      const transformMaskSourceInsidePixel = transformMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-inside")?.rgba;
      const transformMaskSourceOutsidePixel = transformMaskCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-outside")?.rgba;
      const isTransformMaskTargetPixel = (pixel: readonly number[] | undefined) => Boolean(pixel && pixel[0] > 220 && pixel[1] > 110 && pixel[1] < 180 && pixel[2] < 70);
      if (
        !isTransformMaskTargetPixel(transformMaskInsidePixel) || isTransformMaskTargetPixel(transformMaskOutsidePixel)
        || !isTransformMaskTargetPixel(transformMaskSourceInsidePixel) || isTransformMaskTargetPixel(transformMaskSourceOutsidePixel)
      ) {
        throw new Error(`TransformGroup mask Canvas probes were wrong: derived=${transformMaskInsidePixel?.join(",") ?? "missing"}/${transformMaskOutsidePixel?.join(",") ?? "missing"}, source=${transformMaskSourceInsidePixel?.join(",") ?? "missing"}/${transformMaskSourceOutsidePixel?.join(",") ?? "missing"}.`);
      }
      const transformMaskInsideWorld = transformPoint(transformMaskMatrix, transformPoint(transformMaskTargetWorld, { x: 40, y: 40 }));
      const transformMaskInsideScreen = {
        x: (transformMaskInsideWorld.x + transformMaskSnapshot.viewport.x) * transformMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (transformMaskInsideWorld.y + transformMaskSnapshot.viewport.y) * transformMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const transformMaskHitPromise = waitForViewState(() => true, "TransformGroup mask Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...transformMaskInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const transformMaskHit = await transformMaskHitPromise;
      if (transformMaskHit.selectedIds[0] !== transformMaskedTarget.id) throw new Error("TransformGroup mask Repeat did not resolve its canonical target inside repeated source alpha.");
      const transformMaskOutsideWorld = transformPoint(transformMaskMatrix, transformPoint(transformMaskTargetWorld, { x: 90, y: 40 }));
      const transformMaskOutsideScreen = {
        x: (transformMaskOutsideWorld.x + transformMaskSnapshot.viewport.x) * transformMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
        y: (transformMaskOutsideWorld.y + transformMaskSnapshot.viewport.y) * transformMaskSnapshot.viewport.zoom + hitCanvasSize / 2,
      };
      const transformMaskOutsidePromise = waitForViewState(() => true, "TransformGroup mask Repeat alpha rejection");
      worker.postMessage({ type: "pointer", event: "down", ...transformMaskOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const transformMaskOutside = await transformMaskOutsidePromise;
      if (transformMaskOutside.selectedIds.includes(transformMaskedTarget.id) || latestSnapshotRef.current?.revision !== transformMaskRevision) {
        throw new Error("TransformGroup mask Repeat exposed its target outside repeated source alpha or advanced revision.");
      }
      append(`TransformGroup mask Repeat Canvas ${transformMaskCanvas.rgbaSha256} probes derived=${transformMaskInsidePixel!.join(",")}/${transformMaskOutsidePixel!.join(",")} source=${transformMaskSourceInsidePixel!.join(",")}/${transformMaskSourceOutsidePixel!.join(",")}, deep-hit and two-mask SVG passed at revision ${transformMaskRevision}.`);

      const transformMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > transformMaskRevision && !next.nodes.some((node) => node.id === transformMaskOuterRepeat.id),
        "TransformGroup mask outer Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const transformMaskUndone = await transformMaskUndoPromise;
      if (!transformMaskOuterRepeat.removed || transformMask.removed || transformMaskLeaf.removed || transformMaskedTarget.removed || !transformMask.isMask) {
        throw new Error("TransformGroup mask Repeat Undo did not restore the masked source subtree.");
      }
      append(`TransformGroup mask outer Repeat Undo retired the wrapper and restored the masked source at revision ${transformMaskUndone.revision}.`);
      const transformMaskSetUndoPromise = waitForSnapshot(
        (next) => next.revision > transformMaskUndone.revision && !next.nodes.find((node) => node.id === transformMask.id)?.isMask,
        "TransformGroup SetMask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const transformMaskSetUndone = await transformMaskSetUndoPromise;
      if (transformMask.removed || transformMaskLeaf.removed || transformMaskedTarget.removed || transformMask.isMask) {
        throw new Error("TransformGroup SetMask Undo did not restore the unmasked source.");
      }
      append(`TransformGroup SetMask Undo restored the unmasked source at revision ${transformMaskSetUndone.revision}.`);
      const transformMaskSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > transformMaskSetUndone.revision && !next.nodes.some((node) => [transformMask.id, transformMaskLeaf.id, transformMaskedTarget.id].includes(node.id)),
        "TransformGroup mask source creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const transformMaskSourceUndone = await transformMaskSourceUndoPromise;
      if (!transformMask.removed || !transformMaskLeaf.removed || !transformMaskedTarget.removed || transformMaskSourceRevision >= transformMaskSetRevision || transformMaskSetRevision >= transformMaskRevision) {
        throw new Error("TransformGroup mask source Undo did not retire the complete source subtree.");
      }
      append(`TransformGroup mask source Undo retired the complete subtree at revision ${transformMaskSourceUndone.revision}.`);

      const effectedGroupMask = runtime.createGroup();
      effectedGroupMask.name = "Repeat translucent Layer Blur Group mask";
      effectedGroupMask.x = 40;
      effectedGroupMask.y = 480;
      effectedGroupMask.resize(100, 80);
      const effectedGroupMaskChild = runtime.createEllipse();
      effectedGroupMaskChild.name = "Layer Blur Group mask alpha child";
      // Keep the fixed centre probe well inside the blurred source alpha while
      // the fixed outside probe remains beyond the conservative blur tail.
      effectedGroupMaskChild.x = 45;
      effectedGroupMaskChild.y = 490;
      effectedGroupMaskChild.resize(70, 60);
      effectedGroupMaskChild.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      effectedGroupMask.appendChild(effectedGroupMaskChild);
      const effectedGroupTarget = runtime.createRectangle();
      effectedGroupTarget.name = "Layer-Blur-Group-mask Repeat target";
      effectedGroupTarget.x = 40;
      effectedGroupTarget.y = 480;
      effectedGroupTarget.resize(100, 80);
      effectedGroupTarget.fills = [{ type: "SOLID", color: { r: 0.55, g: 0.3, b: 0.95 } }];
      const effectedGroupSourceRevision = await runtime.commitAsync();
      if (latestSnapshotRef.current?.nodes.filter((node) => node.parentId === effectedGroupMask.id).length !== 1) {
        throw new Error("Layer Blur Group mask source did not preserve its descendant alpha structure.");
      }
      append(`Layer Blur Group mask source committed at revision ${effectedGroupSourceRevision}.`);
      const effectedGroupUpdatePromise = waitForSnapshot(
        (next) => {
          const canonical = next.nodes.find((node) => node.id === effectedGroupMask.id);
          return next.revision > effectedGroupSourceRevision
            && canonical?.opacity === .5
            && canonical.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION]?.[0] === 1
            && Boolean(canonical.effectStack?.[0]?.layerBlur);
        },
        "translucent Layer Blur Group mask presentation projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: effectedGroupSourceRevision,
          commands: [{
            type: "update",
            id: effectedGroupMask.id,
            patch: {
              opacity: .5,
              extensions: { [NORMAL_BLEND_ISOLATION_EXTENSION]: [1] },
              effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
            },
          }],
        },
      } satisfies MainToWorker);
      const effectedGroupEffectSnapshot = await effectedGroupUpdatePromise;
      append(`Layer Blur Group mask opacity, NORMAL isolation and effect committed at revision ${effectedGroupEffectSnapshot.revision}.`);
      effectedGroupMask.isMask = true;
      const effectedGroupSetMaskRevision = await runtime.commitAsync();
      if (!latestSnapshotRef.current?.nodes.find((node) => node.id === effectedGroupMask.id)?.isMask) {
        throw new Error("Layer Blur Group mask did not survive Runtime SetMask.");
      }
      append(`Layer Blur Group Runtime SetMask passed at revision ${effectedGroupSetMaskRevision}.`);
      const effectedGroupRepeat = runtime.transformGroup(
        [effectedGroupMask, effectedGroupTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      effectedGroupRepeat.name = "Layer Blur Group mask Repeat";
      const effectedGroupRepeatRevision = await runtime.commitAsync();
      const effectedGroupSnapshot = latestSnapshotRef.current;
      const effectedGroupRepeatCanonical = effectedGroupSnapshot?.nodes.find((node) => node.id === effectedGroupRepeat.id);
      const effectedGroupTargetCanonical = effectedGroupSnapshot?.nodes.find((node) => node.id === effectedGroupTarget.id);
      const effectedGroupMatrix = effectedGroupSnapshot && effectedGroupRepeatCanonical
        ? transformGroupRepeatMatrices(effectedGroupSnapshot.nodes, effectedGroupRepeatCanonical)?.[0]
        : undefined;
      const effectedGroupTargetWorld = effectedGroupSnapshot && effectedGroupTargetCanonical
        ? worldTransformForNode(effectedGroupSnapshot.nodes, effectedGroupTargetCanonical.id)
        : undefined;
      const effectedGroupSvg = await effectedGroupRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !effectedGroupMatrix || !effectedGroupTargetWorld
        || (effectedGroupSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || (effectedGroupSvg.match(/<feGaussianBlur/gu)?.length ?? 0) !== 2
        || (effectedGroupSvg.match(/opacity="0.5"/gu)?.length ?? 0) !== 2
        || (effectedGroupSvg.match(/style="isolation:isolate"/gu)?.length ?? 0) !== 2
        || !effectedGroupSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Layer Blur Group mask Repeat did not preserve its two translucent filtered SVG alpha sources and derived matrix.");
      const effectedGroupCanvas = await waitForFrameHash((frame) => frame.revision === effectedGroupRepeatRevision, "Layer Blur Group mask Repeat frame hash");
      const effectedGroupInside = effectedGroupCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-inside")?.rgba;
      const effectedGroupOutside = effectedGroupCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-outside")?.rgba;
      const effectedGroupSourceInside = effectedGroupCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-inside")?.rgba;
      const effectedGroupSourceOutside = effectedGroupCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-outside")?.rgba;
      const isEffectedGroupTargetPixel = (pixel: readonly number[] | undefined) => Boolean(pixel && pixel[0] > 180 && pixel[0] < 200 && pixel[1] > 145 && pixel[1] < 170 && pixel[2] > 230);
      if (
        !isEffectedGroupTargetPixel(effectedGroupInside) || isEffectedGroupTargetPixel(effectedGroupOutside)
        || !isEffectedGroupTargetPixel(effectedGroupSourceInside) || isEffectedGroupTargetPixel(effectedGroupSourceOutside)
      ) {
        throw new Error(`Layer Blur Group mask Canvas probes were wrong: derived=${effectedGroupInside?.join(",") ?? "missing"}/${effectedGroupOutside?.join(",") ?? "missing"}, source=${effectedGroupSourceInside?.join(",") ?? "missing"}/${effectedGroupSourceOutside?.join(",") ?? "missing"}.`);
      }
      const effectedGroupInsideWorld = transformPoint(effectedGroupMatrix, transformPoint(effectedGroupTargetWorld, { x: 40, y: 40 }));
      const effectedGroupInsideScreen = {
        x: (effectedGroupInsideWorld.x + effectedGroupSnapshot!.viewport.x) * effectedGroupSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (effectedGroupInsideWorld.y + effectedGroupSnapshot!.viewport.y) * effectedGroupSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const effectedGroupHitPromise = waitForViewState(() => true, "Layer Blur Group mask Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...effectedGroupInsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const effectedGroupHit = await effectedGroupHitPromise;
      if (effectedGroupHit.selectedIds[0] !== effectedGroupTarget.id) {
        throw new Error("Layer Blur Group mask Repeat did not resolve its canonical target inside filtered source alpha.");
      }
      const effectedGroupOutsideWorld = transformPoint(effectedGroupMatrix, transformPoint(effectedGroupTargetWorld, { x: 90, y: 40 }));
      const effectedGroupOutsideScreen = {
        x: (effectedGroupOutsideWorld.x + effectedGroupSnapshot!.viewport.x) * effectedGroupSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (effectedGroupOutsideWorld.y + effectedGroupSnapshot!.viewport.y) * effectedGroupSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const effectedGroupOutsidePromise = waitForViewState(() => true, "Layer Blur Group mask Repeat alpha rejection");
      worker.postMessage({ type: "pointer", event: "down", ...effectedGroupOutsideScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const effectedGroupOutsideHit = await effectedGroupOutsidePromise;
      if (effectedGroupOutsideHit.selectedIds.includes(effectedGroupTarget.id) || latestSnapshotRef.current?.revision !== effectedGroupRepeatRevision) {
        throw new Error("Layer Blur Group mask Repeat exposed its target outside filtered source alpha or advanced revision.");
      }
      append(`Translucent Layer Blur Group mask Repeat Canvas ${effectedGroupCanvas.rgbaSha256} probes derived=${effectedGroupInside!.join(",")}/${effectedGroupOutside!.join(",")} source=${effectedGroupSourceInside!.join(",")}/${effectedGroupSourceOutside!.join(",")}, deep-hit and two translucent filtered SVG masks passed at revision ${effectedGroupRepeatRevision}.`);

      const effectedGroupBlendPromise = waitForSnapshot(
        (next) => {
          const canonical = next.nodes.find((node) => node.id === effectedGroupMask.id);
          return next.revision > effectedGroupRepeatRevision
            && canonical?.blendMode === "multiply"
            && canonical.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION] === undefined;
        },
        "Multiply Group mask projection",
      );
      effectedGroupMask.blendMode = "MULTIPLY";
      const effectedGroupBlendRevision = await runtime.commitAsync();
      const effectedGroupBlendSnapshot = await effectedGroupBlendPromise;
      if (effectedGroupBlendRevision !== effectedGroupBlendSnapshot.revision || !effectedGroupMask.isMask) {
        throw new Error("Multiply Group mask Runtime update did not preserve SetMask or its revision fence.");
      }
      const effectedGroupBlendSvg = await effectedGroupRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        (effectedGroupBlendSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || (effectedGroupBlendSvg.match(/style="mix-blend-mode:multiply"/gu)?.length ?? 0) !== 2
        || (effectedGroupBlendSvg.match(/style="isolation:isolate"/gu)?.length ?? 0) !== 0
        || (effectedGroupBlendSvg.match(/opacity="0.5"/gu)?.length ?? 0) !== 2
        || (effectedGroupBlendSvg.match(/<feGaussianBlur/gu)?.length ?? 0) !== 2
      ) throw new Error(`Multiply Group mask Repeat SVG mismatch: masks=${effectedGroupBlendSvg.match(/<mask /gu)?.length ?? 0}, blend=${effectedGroupBlendSvg.match(/style="mix-blend-mode:multiply"/gu)?.length ?? 0}, isolation=${effectedGroupBlendSvg.match(/style="isolation:isolate"/gu)?.length ?? 0}, opacity=${effectedGroupBlendSvg.match(/opacity="0.5"/gu)?.length ?? 0}, blur=${effectedGroupBlendSvg.match(/<feGaussianBlur/gu)?.length ?? 0}.`);
      const effectedGroupBlendCanvas = await waitForFrameHash(
        (frame) => frame.revision === effectedGroupBlendSnapshot.revision,
        "Multiply Group mask Repeat frame hash",
      );
      const blendSamplesMatch = [
        ["repeat-frame-mask-inside", effectedGroupInside],
        ["repeat-frame-mask-outside", effectedGroupOutside],
        ["repeat-frame-mask-source-inside", effectedGroupSourceInside],
        ["repeat-frame-mask-source-outside", effectedGroupSourceOutside],
      ].every(([label, expected]) => {
        const actual = effectedGroupBlendCanvas.samples?.find((sample) => sample.label === label)?.rgba;
        return actual?.every((value, index) => value === expected?.[index]);
      });
      if (!blendSamplesMatch) {
        const blendProbeText = effectedGroupBlendCanvas.samples
          ?.filter((sample) => sample.label.startsWith("repeat-frame-mask"))
          .map((sample) => `${sample.label}=${sample.rgba.join(",")}`)
          .join(";");
        throw new Error(`Multiply Group mask changed source alpha probes: ${blendProbeText ?? "missing probes"}.`);
      }
      append(`Multiply Group mask preserved Canvas ${effectedGroupBlendCanvas.rgbaSha256}, four probes and two blended SVG masks at revision ${effectedGroupBlendSnapshot.revision}.`);
      const effectedGroupBlendUndoPromise = waitForSnapshot(
        (next) => {
          const canonical = next.nodes.find((node) => node.id === effectedGroupMask.id);
          return next.revision > effectedGroupBlendSnapshot.revision
            && canonical?.blendMode === "normal"
            && canonical.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION]?.[0] === 1;
        },
        "Multiply Group mask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedGroupBlendUndone = await effectedGroupBlendUndoPromise;
      append(`Multiply Group mask Undo restored explicit NORMAL isolation at revision ${effectedGroupBlendUndone.revision}.`);

      const effectedGroupRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > effectedGroupBlendUndone.revision && !next.nodes.some((node) => node.id === effectedGroupRepeat.id),
        "Layer Blur Group mask Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedGroupRepeatUndone = await effectedGroupRepeatUndoPromise;
      const effectedGroupMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > effectedGroupRepeatUndone.revision && !next.nodes.find((node) => node.id === effectedGroupMask.id)?.isMask,
        "Layer Blur Group mask SetMask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedGroupMaskUndone = await effectedGroupMaskUndoPromise;
      const effectedGroupEffectUndoPromise = waitForSnapshot(
        (next) => {
          const canonical = next.nodes.find((node) => node.id === effectedGroupMask.id);
          return next.revision > effectedGroupMaskUndone.revision
            && canonical?.opacity === 1
            && canonical.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION] === undefined
            && !canonical.effectStack?.length;
        },
        "Layer Blur Group mask presentation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedGroupEffectUndone = await effectedGroupEffectUndoPromise;
      const effectedGroupSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > effectedGroupEffectUndone.revision && !next.nodes.some((node) => [effectedGroupMask.id, effectedGroupMaskChild.id, effectedGroupTarget.id].includes(node.id)),
        "Layer Blur Group mask source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedGroupSourceUndone = await effectedGroupSourceUndoPromise;
      if (!effectedGroupRepeat.removed || !effectedGroupMask.removed || !effectedGroupMaskChild.removed || !effectedGroupTarget.removed) {
        throw new Error("Layer Blur Group mask Undo sequence did not retire the complete source subtree.");
      }
      append(`Layer Blur Group mask Undo sequence passed through revision ${effectedGroupSourceUndone.revision}.`);

      const effectedContainerBackdrop = runtime.createRectangle();
      effectedContainerBackdrop.name = "Repeat effect blend backdrop";
      effectedContainerBackdrop.x = 20;
      effectedContainerBackdrop.y = 525;
      effectedContainerBackdrop.resize(520, 70);
      effectedContainerBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const effectedContainer = runtime.createGroup();
      effectedContainer.name = "Repeated Layer Blur Group";
      effectedContainer.x = 40;
      effectedContainer.y = 480;
      effectedContainer.resize(100, 80);
      const effectedContainerChild = runtime.createEllipse();
      effectedContainerChild.name = "Repeated Layer Blur Group child";
      effectedContainerChild.x = 45;
      effectedContainerChild.y = 490;
      effectedContainerChild.resize(70, 60);
      effectedContainerChild.fills = [{ type: "SOLID", color: { r: .1, g: .65, b: .9 } }];
      effectedContainer.appendChild(effectedContainerChild);
      const effectedContainerBlend = runtime.createRectangle();
      effectedContainerBlend.name = "Repeated Multiply sibling";
      effectedContainerBlend.x = 40;
      effectedContainerBlend.y = 530;
      effectedContainerBlend.resize(80, 40);
      effectedContainerBlend.fills = [{ type: "SOLID", color: { r: .5, g: .8, b: .4 } }];
      effectedContainerBlend.blendMode = "MULTIPLY";
      const effectedContainerLinearPaint = runtime.createRectangle();
      effectedContainerLinearPaint.name = "Repeated Linear Dodge paint sibling";
      effectedContainerLinearPaint.x = 140;
      effectedContainerLinearPaint.y = 530;
      effectedContainerLinearPaint.resize(40, 40);
      effectedContainerLinearPaint.fills = [{
        type: "SOLID",
        color: { r: .1, g: .2, b: .3 },
        opacity: 1,
        blendMode: "LINEAR_DODGE",
      }];
      const effectedContainerLinearNode = runtime.createRectangle();
      effectedContainerLinearNode.name = "Repeated Linear Burn node sibling";
      effectedContainerLinearNode.x = 200;
      effectedContainerLinearNode.y = 530;
      effectedContainerLinearNode.resize(40, 40);
      effectedContainerLinearNode.fills = [{ type: "SOLID", color: { r: .3, g: .2, b: .1 } }];
      effectedContainerLinearNode.blendMode = "LINEAR_BURN";
      const effectedContainerOffscreenEffect = runtime.createEllipse();
      effectedContainerOffscreenEffect.name = "Offscreen source repeated Layer Blur";
      effectedContainerOffscreenEffect.x = -180;
      effectedContainerOffscreenEffect.y = 575;
      effectedContainerOffscreenEffect.resize(40, 20);
      effectedContainerOffscreenEffect.fills = [{ type: "SOLID", color: { r: .9, g: .2, b: .6 } }];
      const effectedContainerOffscreenLinear = runtime.createRectangle();
      effectedContainerOffscreenLinear.name = "Offscreen source repeated Linear Dodge paint";
      effectedContainerOffscreenLinear.x = -80;
      effectedContainerOffscreenLinear.y = 575;
      effectedContainerOffscreenLinear.resize(40, 20);
      effectedContainerOffscreenLinear.fills = [{
        type: "SOLID",
        color: { r: .1, g: .2, b: .3 },
        opacity: 1,
        blendMode: "LINEAR_DODGE",
      }];
      const effectedContainerSourceRevision = await runtime.commitAsync();
      if (latestSnapshotRef.current?.nodes.find((node) => node.id === effectedContainerChild.id)?.parentId !== effectedContainer.id) {
        throw new Error("Layer Blur Group source did not preserve its descendant structure.");
      }
      append(`Layer Blur Group source committed at revision ${effectedContainerSourceRevision}.`);
      const effectedContainerUpdatePromise = waitForSnapshot(
        (next) => next.revision > effectedContainerSourceRevision
          && Boolean(next.nodes.find((node) => node.id === effectedContainer.id)?.effectStack?.[0]?.layerBlur)
          && Boolean(next.nodes.find((node) => node.id === effectedContainerOffscreenEffect.id)?.effectStack?.[0]?.layerBlur),
        "Layer Blur Group effect projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: effectedContainerSourceRevision,
          commands: [effectedContainer.id, effectedContainerOffscreenEffect.id].map((id) => ({
            type: "update" as const,
            id,
            patch: { effectStack: [{ layerBlur: { visible: true, radius: 4 } }] },
          })),
        },
      } satisfies MainToWorker);
      const effectedContainerEffectSnapshot = await effectedContainerUpdatePromise;
      append(`Layer Blur Group effect committed at revision ${effectedContainerEffectSnapshot.revision}.`);
      const effectedContainerRepeat = runtime.transformGroup(
        [effectedContainer, effectedContainerBlend, effectedContainerLinearPaint, effectedContainerLinearNode, effectedContainerOffscreenEffect, effectedContainerOffscreenLinear],
        runtime.currentPage,
        runtime.currentPage.children.length - 6,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      effectedContainerRepeat.name = "Layer Blur Group Repeat";
      const effectedContainerRepeatRevision = await runtime.commitAsync();
      const effectedContainerSnapshot = latestSnapshotRef.current;
      const effectedContainerRepeatCanonical = effectedContainerSnapshot?.nodes.find((node) => node.id === effectedContainerRepeat.id);
      const effectedContainerChildCanonical = effectedContainerSnapshot?.nodes.find((node) => node.id === effectedContainerChild.id);
      const effectedContainerMatrix = effectedContainerSnapshot && effectedContainerRepeatCanonical
        ? transformGroupRepeatMatrices(effectedContainerSnapshot.nodes, effectedContainerRepeatCanonical)?.[0]
        : undefined;
      const effectedContainerChildWorld = effectedContainerSnapshot && effectedContainerChildCanonical
        ? worldTransformForNode(effectedContainerSnapshot.nodes, effectedContainerChildCanonical.id)
        : undefined;
      const effectedContainerSvg = await effectedContainerRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !effectedContainerMatrix || !effectedContainerChildWorld
        || (effectedContainerSvg.match(/<feGaussianBlur/gu)?.length ?? 0) !== 4
        || (effectedContainerSvg.match(/style="mix-blend-mode:multiply"/gu)?.length ?? 0) !== 2
        || !effectedContainerSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Layer Blur Group Repeat did not preserve its two filtered SVG subtrees and derived matrix.");
      const effectedContainerCanvas = await waitForFrameHash(
        (frame) => frame.revision === effectedContainerRepeatRevision,
        "Layer Blur Group Repeat frame hash",
      );
      const effectedContainerInside = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-inside")?.rgba;
      const effectedContainerOutside = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-outside")?.rgba;
      const effectedContainerSourceInside = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-inside")?.rgba;
      const effectedContainerSourceOutside = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-frame-mask-source-outside")?.rgba;
      const effectedContainerBlendSource = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-effect-blend-source")?.rgba;
      const effectedContainerBlendDerived = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-effect-blend-derived")?.rgba;
      const effectedContainerLinearPaintSource = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-linear-paint-source")?.rgba;
      const effectedContainerLinearPaintDerived = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-linear-paint-derived")?.rgba;
      const effectedContainerLinearNodeSource = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-linear-node-source")?.rgba;
      const effectedContainerLinearNodeDerived = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-linear-node-derived")?.rgba;
      const effectedContainerOffscreenEffectDerived = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-offscreen-effect-derived")?.rgba;
      const effectedContainerOffscreenLinearDerived = effectedContainerCanvas.samples?.find((sample) => sample.label === "repeat-offscreen-linear-derived")?.rgba;
      const isEffectedContainerPixel = (pixel: readonly number[] | undefined) => Boolean(
        pixel && pixel[0] > 15 && pixel[0] < 40 && pixel[1] > 150 && pixel[1] < 180 && pixel[2] > 215 && pixel[2] < 240,
      );
      if (
        !isEffectedContainerPixel(effectedContainerInside) || isEffectedContainerPixel(effectedContainerOutside)
        || !isEffectedContainerPixel(effectedContainerSourceInside) || isEffectedContainerPixel(effectedContainerSourceOutside)
        || !effectedContainerBlendSource || !effectedContainerBlendDerived
        || effectedContainerBlendSource.some((channel, index) => channel !== effectedContainerBlendDerived[index])
        || effectedContainerBlendDerived[0] > 30
        || effectedContainerBlendDerived[1] < 120 || effectedContainerBlendDerived[1] > 145
        || effectedContainerBlendDerived[2] < 80 || effectedContainerBlendDerived[2] > 105
        || !effectedContainerLinearPaintSource || !effectedContainerLinearPaintDerived
        || effectedContainerLinearPaintSource.some((channel, index) => channel !== effectedContainerLinearPaintDerived[index])
        || effectedContainerLinearPaintDerived[0] < 225 || effectedContainerLinearPaintDerived[0] > 235
        || effectedContainerLinearPaintDerived[1] < 174 || effectedContainerLinearPaintDerived[1] > 184
        || effectedContainerLinearPaintDerived[2] < 135 || effectedContainerLinearPaintDerived[2] > 145
        || !effectedContainerLinearNodeSource || !effectedContainerLinearNodeDerived
        || effectedContainerLinearNodeSource.some((channel, index) => channel !== effectedContainerLinearNodeDerived[index])
        || effectedContainerLinearNodeDerived[0] < 20 || effectedContainerLinearNodeDerived[0] > 31
        || effectedContainerLinearNodeDerived[1] > 3 || effectedContainerLinearNodeDerived[2] > 3
        || !effectedContainerOffscreenEffectDerived
        || effectedContainerOffscreenEffectDerived[0] < 225 || effectedContainerOffscreenEffectDerived[0] > 235
        || effectedContainerOffscreenEffectDerived[1] < 45 || effectedContainerOffscreenEffectDerived[1] > 57
        || effectedContainerOffscreenEffectDerived[2] < 147 || effectedContainerOffscreenEffectDerived[2] > 159
        || !effectedContainerOffscreenLinearDerived
        || effectedContainerOffscreenLinearDerived[0] < 225 || effectedContainerOffscreenLinearDerived[0] > 235
        || effectedContainerOffscreenLinearDerived[1] < 174 || effectedContainerOffscreenLinearDerived[1] > 184
        || effectedContainerOffscreenLinearDerived[2] < 135 || effectedContainerOffscreenLinearDerived[2] > 145
      ) {
        throw new Error(`Layer Blur Group Repeat Canvas probes were wrong: derived=${effectedContainerInside?.join(",") ?? "missing"}/${effectedContainerOutside?.join(",") ?? "missing"}, source=${effectedContainerSourceInside?.join(",") ?? "missing"}/${effectedContainerSourceOutside?.join(",") ?? "missing"}, multiply=${effectedContainerBlendSource?.join(",") ?? "missing"}/${effectedContainerBlendDerived?.join(",") ?? "missing"}, linear-paint=${effectedContainerLinearPaintSource?.join(",") ?? "missing"}/${effectedContainerLinearPaintDerived?.join(",") ?? "missing"}, linear-node=${effectedContainerLinearNodeSource?.join(",") ?? "missing"}/${effectedContainerLinearNodeDerived?.join(",") ?? "missing"}, offscreen-effect=${effectedContainerOffscreenEffectDerived?.join(",") ?? "missing"}, offscreen-linear=${effectedContainerOffscreenLinearDerived?.join(",") ?? "missing"}.`);
      }
      const effectedContainerHitWorld = transformPoint(
        effectedContainerMatrix,
        transformPoint(effectedContainerChildWorld, { x: effectedContainerChildCanonical!.width / 2, y: 20 }),
      );
      const effectedContainerHitScreen = {
        x: (effectedContainerHitWorld.x + effectedContainerSnapshot!.viewport.x) * effectedContainerSnapshot!.viewport.zoom + hitCanvasSize / 2,
        y: (effectedContainerHitWorld.y + effectedContainerSnapshot!.viewport.y) * effectedContainerSnapshot!.viewport.zoom + hitCanvasSize / 2,
      };
      const effectedContainerHitPromise = waitForViewState(() => true, "Layer Blur Group Repeat deep selection");
      worker.postMessage({ type: "pointer", event: "down", ...effectedContainerHitScreen, shiftKey: false, altKey: false, button: 0, readOnly: true, deepSelect: true } satisfies MainToWorker);
      const effectedContainerHit = await effectedContainerHitPromise;
      if (effectedContainerHit.selectedIds[0] !== effectedContainerChild.id || latestSnapshotRef.current?.revision !== effectedContainerRepeatRevision) {
        throw new Error(`Layer Blur Group Repeat selected ${effectedContainerHit.selectedIds.join(",") || "nothing"} instead of ${effectedContainerChild.id} at revision ${latestSnapshotRef.current?.revision ?? "missing"}/${effectedContainerRepeatRevision}.`);
      }
      append(`Layer Blur Group Repeat Canvas ${effectedContainerCanvas.rgbaSha256} probes derived=${effectedContainerInside!.join(",")}/${effectedContainerOutside!.join(",")} source=${effectedContainerSourceInside!.join(",")}/${effectedContainerSourceOutside!.join(",")} multiply=${effectedContainerBlendSource!.join(",")}/${effectedContainerBlendDerived!.join(",")} linear-paint=${effectedContainerLinearPaintSource!.join(",")}/${effectedContainerLinearPaintDerived!.join(",")} linear-node=${effectedContainerLinearNodeSource!.join(",")}/${effectedContainerLinearNodeDerived!.join(",")} offscreen-effect=${effectedContainerOffscreenEffectDerived!.join(",")} offscreen-linear=${effectedContainerOffscreenLinearDerived!.join(",")}, deep-hit and four-filter SVG passed at revision ${effectedContainerRepeatRevision}.`);
      const effectedContainerRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > effectedContainerRepeatRevision && !next.nodes.some((node) => node.id === effectedContainerRepeat.id),
        "Layer Blur Group Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedContainerRepeatUndone = await effectedContainerRepeatUndoPromise;
      const effectedContainerEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > effectedContainerRepeatUndone.revision
          && !next.nodes.find((node) => node.id === effectedContainer.id)?.effectStack?.length,
        "Layer Blur Group effect Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedContainerEffectUndone = await effectedContainerEffectUndoPromise;
      const effectedContainerSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > effectedContainerEffectUndone.revision
          && !next.nodes.some((node) => [effectedContainerBackdrop.id, effectedContainer.id, effectedContainerChild.id, effectedContainerBlend.id, effectedContainerLinearPaint.id, effectedContainerLinearNode.id, effectedContainerOffscreenEffect.id, effectedContainerOffscreenLinear.id].includes(node.id)),
        "Layer Blur Group source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const effectedContainerSourceUndone = await effectedContainerSourceUndoPromise;
      if (!effectedContainerRepeat.removed || !effectedContainerBackdrop.removed || !effectedContainer.removed || !effectedContainerChild.removed || !effectedContainerBlend.removed || !effectedContainerLinearPaint.removed || !effectedContainerLinearNode.removed || !effectedContainerOffscreenEffect.removed || !effectedContainerOffscreenLinear.removed) {
        throw new Error("Layer Blur Group Undo sequence did not retire its wrapper and source subtree.");
      }
      append(`Layer Blur Group Undo sequence passed through revision ${effectedContainerSourceUndone.revision}.`);

      const backgroundBlurBackdrop = runtime.createRectangle();
      backgroundBlurBackdrop.name = "Repeat Background Blur backdrop";
      backgroundBlurBackdrop.x = -230;
      backgroundBlurBackdrop.y = 525;
      backgroundBlurBackdrop.resize(380, 70);
      backgroundBlurBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const backgroundBlurSourceStripe = runtime.createRectangle();
      backgroundBlurSourceStripe.name = "Repeat Background Blur source stripe";
      backgroundBlurSourceStripe.x = -200;
      backgroundBlurSourceStripe.y = 525;
      backgroundBlurSourceStripe.resize(20, 70);
      backgroundBlurSourceStripe.fills = [{ type: "SOLID", color: { r: .95, g: .1, b: .15 } }];
      const backgroundBlurDerivedStripe = runtime.createRectangle();
      backgroundBlurDerivedStripe.name = "Repeat Background Blur derived stripe";
      backgroundBlurDerivedStripe.x = 100;
      backgroundBlurDerivedStripe.y = 525;
      backgroundBlurDerivedStripe.resize(20, 70);
      backgroundBlurDerivedStripe.fills = [{ type: "SOLID", color: { r: .1, g: .25, b: .95 } }];
      const backgroundBlurLeaf = runtime.createRectangle();
      backgroundBlurLeaf.name = "Repeated Background Blur leaf";
      backgroundBlurLeaf.x = -200;
      backgroundBlurLeaf.y = 530;
      backgroundBlurLeaf.resize(40, 30);
      backgroundBlurLeaf.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      const backgroundBlurGroup = runtime.createGroup();
      backgroundBlurGroup.name = "Repeated Background Blur Group";
      backgroundBlurGroup.x = -200;
      backgroundBlurGroup.y = 570;
      backgroundBlurGroup.resize(40, 20);
      const backgroundBlurGroupChild = runtime.createRectangle();
      backgroundBlurGroupChild.name = "Repeated Background Blur Group alpha";
      backgroundBlurGroupChild.x = -200;
      backgroundBlurGroupChild.y = 570;
      backgroundBlurGroupChild.resize(40, 20);
      backgroundBlurGroupChild.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      backgroundBlurGroup.appendChild(backgroundBlurGroupChild);
      const backgroundBlurSourceRevision = await runtime.commitAsync();
      append(`Background Blur Repeat source committed at revision ${backgroundBlurSourceRevision}.`);
      const backgroundBlurEffectPromise = waitForSnapshot(
        (next) => next.revision > backgroundBlurSourceRevision
          && Boolean(next.nodes.find((node) => node.id === backgroundBlurLeaf.id)?.effectStack?.some((effect) => effect.backgroundBlur))
          && Boolean(next.nodes.find((node) => node.id === backgroundBlurGroup.id)?.effectStack?.some((effect) => effect.backgroundBlur)),
        "Background Blur Repeat effect projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: backgroundBlurSourceRevision,
          commands: [
            {
              type: "update",
              id: backgroundBlurLeaf.id,
              patch: { effectStack: [
                { layerBlur: { visible: true, radius: 2 } },
                { backgroundBlur: { visible: true, radius: 6 } },
              ] },
            },
            {
              type: "update",
              id: backgroundBlurGroup.id,
              patch: { effectStack: [
                { backgroundBlur: { visible: true, radius: 6 } },
                { dropShadow: { visible: true, offsetX: 3, offsetY: 2, blurRadius: 2, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .35 } } },
              ] },
            },
          ],
        },
      } satisfies MainToWorker);
      const backgroundBlurEffectSnapshot = await backgroundBlurEffectPromise;
      append(`Background Blur Repeat effects committed at revision ${backgroundBlurEffectSnapshot.revision}.`);
      const backgroundBlurRepeat = runtime.transformGroup(
        [backgroundBlurLeaf, backgroundBlurGroup],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      backgroundBlurRepeat.name = "Background Blur Repeat";
      const backgroundBlurRepeatRevision = await runtime.commitAsync();
      const backgroundBlurSvg = await backgroundBlurRepeat.exportAsync({ format: "SVG_STRING" });
      if (!backgroundBlurSvg.includes('transform="matrix(1 0 0 1 300 0)"')) {
        throw new Error("Background Blur Repeat did not retain its structural SVG source and derived matrix fallback.");
      }
      const backgroundBlurCanvas = await waitForFrameHash(
        (frame) => frame.revision === backgroundBlurRepeatRevision,
        "Background Blur Repeat frame hash",
      );
      const backgroundBlurSource = backgroundBlurCanvas.samples?.find((sample) => sample.label === "repeat-background-blur-source")?.rgba;
      const backgroundBlurDerived = backgroundBlurCanvas.samples?.find((sample) => sample.label === "repeat-background-blur-derived")?.rgba;
      const groupBackgroundBlurSource = backgroundBlurCanvas.samples?.find((sample) => sample.label === "repeat-group-background-blur-source")?.rgba;
      const groupBackgroundBlurDerived = backgroundBlurCanvas.samples?.find((sample) => sample.label === "repeat-group-background-blur-derived")?.rgba;
      const seesIndependentBackdrops = (source: readonly number[] | undefined, derived: readonly number[] | undefined) => Boolean(
        source && derived
        && source[3] === 255 && derived[3] === 255
        && source[0] > derived[0] + 5
        && derived[2] > source[2] + 5,
      );
      if (
        !seesIndependentBackdrops(backgroundBlurSource, backgroundBlurDerived)
        || !seesIndependentBackdrops(groupBackgroundBlurSource, groupBackgroundBlurDerived)
      ) {
        throw new Error(`Background Blur Repeat did not sample independent occurrence backdrops: leaf=${backgroundBlurSource?.join(",") ?? "missing"}/${backgroundBlurDerived?.join(",") ?? "missing"}, group=${groupBackgroundBlurSource?.join(",") ?? "missing"}/${groupBackgroundBlurDerived?.join(",") ?? "missing"}.`);
      }
      append(`Background Blur Repeat Canvas ${backgroundBlurCanvas.rgbaSha256} sampled independent source/derived backdrops for leaf=${backgroundBlurSource!.join(",")}/${backgroundBlurDerived!.join(",")} and Group=${groupBackgroundBlurSource!.join(",")}/${groupBackgroundBlurDerived!.join(",")} at revision ${backgroundBlurRepeatRevision}.`);
      const backgroundBlurRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > backgroundBlurRepeatRevision && !next.nodes.some((node) => node.id === backgroundBlurRepeat.id),
        "Background Blur Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const backgroundBlurRepeatUndone = await backgroundBlurRepeatUndoPromise;
      const backgroundBlurEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > backgroundBlurRepeatUndone.revision
          && !next.nodes.find((node) => node.id === backgroundBlurLeaf.id)?.effectStack?.length
          && !next.nodes.find((node) => node.id === backgroundBlurGroup.id)?.effectStack?.length,
        "Background Blur Repeat effect Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const backgroundBlurEffectUndone = await backgroundBlurEffectUndoPromise;
      const backgroundBlurSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > backgroundBlurEffectUndone.revision
          && !next.nodes.some((node) => [backgroundBlurBackdrop.id, backgroundBlurSourceStripe.id, backgroundBlurDerivedStripe.id, backgroundBlurLeaf.id, backgroundBlurGroup.id, backgroundBlurGroupChild.id].includes(node.id)),
        "Background Blur Repeat source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const backgroundBlurSourceUndone = await backgroundBlurSourceUndoPromise;
      if (!backgroundBlurRepeat.removed || !backgroundBlurBackdrop.removed || !backgroundBlurSourceStripe.removed || !backgroundBlurDerivedStripe.removed || !backgroundBlurLeaf.removed || !backgroundBlurGroup.removed || !backgroundBlurGroupChild.removed) {
        throw new Error("Background Blur Repeat Undo sequence did not retire its wrapper and complete source subtree.");
      }
      append(`Background Blur Repeat Undo sequence passed through revision ${backgroundBlurSourceUndone.revision}.`);

      const radialBlurBackdrop = runtime.createRectangle();
      radialBlurBackdrop.name = "Radial Repeat Background Blur backdrop";
      radialBlurBackdrop.x = -330;
      radialBlurBackdrop.y = -470;
      radialBlurBackdrop.resize(100, 210);
      radialBlurBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const radialBlurSourceStripe = runtime.createRectangle();
      radialBlurSourceStripe.name = "Radial Repeat Background Blur source stripe";
      radialBlurSourceStripe.x = -300;
      radialBlurSourceStripe.y = -440;
      radialBlurSourceStripe.resize(40, 30);
      radialBlurSourceStripe.fills = [{ type: "SOLID", color: { r: .95, g: .1, b: .15 } }];
      const radialBlurDerivedStripe = runtime.createRectangle();
      radialBlurDerivedStripe.name = "Radial Repeat Background Blur derived stripe";
      radialBlurDerivedStripe.x = -300;
      radialBlurDerivedStripe.y = -320;
      radialBlurDerivedStripe.resize(40, 30);
      radialBlurDerivedStripe.fills = [{ type: "SOLID", color: { r: .05, g: .2, b: .95 } }];
      const radialBlurLeaf = runtime.createRectangle();
      radialBlurLeaf.name = "Radial repeated Background Blur leaf";
      radialBlurLeaf.x = -300;
      radialBlurLeaf.y = -440;
      radialBlurLeaf.resize(40, 30);
      radialBlurLeaf.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      const radialBlurAnchor = runtime.createRectangle();
      radialBlurAnchor.name = "Radial Repeat geometry anchor";
      radialBlurAnchor.x = -300;
      radialBlurAnchor.y = -320;
      radialBlurAnchor.resize(40, 30);
      radialBlurAnchor.fills = [];
      const radialBlurSourceRevision = await runtime.commitAsync();
      append(`Radial Background Blur Repeat source committed at revision ${radialBlurSourceRevision}.`);
      const radialBlurRepeat = runtime.transformGroup(
        [radialBlurLeaf, radialBlurAnchor],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "RADIAL", count: 1, unitType: "PIXELS", offset: 120 }],
      );
      radialBlurRepeat.name = "Radial Background Blur Repeat";
      const radialBlurStructureRevision = await runtime.commitAsync();
      await runtime.currentPage.setSelectionAsync([]);
      const radialBlurEffectPromise = waitForSnapshot(
        (next) => next.revision > radialBlurStructureRevision
          && Boolean(next.nodes.find((node) => node.id === radialBlurLeaf.id)?.effectStack?.[0]?.backgroundBlur),
        "Radial Background Blur Repeat effect projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: radialBlurStructureRevision,
          commands: [{
            type: "update",
            id: radialBlurLeaf.id,
            patch: { effectStack: [
              { backgroundBlur: { visible: true, radius: 6 } },
              { dropShadow: { visible: true, offsetX: 0, offsetY: 8, blurRadius: 2, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .6 } } },
            ] },
          }],
        },
      } satisfies MainToWorker);
      const radialBlurEffectSnapshot = await radialBlurEffectPromise;
      append(`Radial Background Blur Repeat effect committed at revision ${radialBlurEffectSnapshot.revision}.`);
      const radialBlurRepeatRevision = radialBlurEffectSnapshot.revision;
      const radialBlurSvg = await radialBlurRepeat.exportAsync({ format: "SVG_STRING" });
      if (!radialBlurSvg.includes('transform="matrix(-1 0 0 -1')) {
        throw new Error("Radial Background Blur Repeat did not retain its half-turn structural SVG fallback.");
      }
      const radialBlurCanvas = await waitForFrameHash(
        (frame) => frame.revision === radialBlurRepeatRevision,
        "Radial Background Blur Repeat frame hash",
      );
      const radialBlurSource = radialBlurCanvas.samples?.find((sample) => sample.label === "repeat-radial-background-blur-source")?.rgba;
      const radialBlurDerived = radialBlurCanvas.samples?.find((sample) => sample.label === "repeat-radial-background-blur-derived")?.rgba;
      const radialBlurRotatedShadow = radialBlurCanvas.samples?.find((sample) => sample.label === "repeat-radial-background-blur-shadow-rotated")?.rgba;
      const radialBlurUnrotatedShadowControl = radialBlurCanvas.samples?.find((sample) => sample.label === "repeat-radial-background-blur-shadow-unrotated-control")?.rgba;
      const rgbSum = (rgba: readonly number[] | undefined) => rgba ? rgba[0]! + rgba[1]! + rgba[2]! : Number.POSITIVE_INFINITY;
      if (
        !radialBlurSource || !radialBlurDerived
        || !radialBlurRotatedShadow || !radialBlurUnrotatedShadowControl
        || radialBlurSource[3] !== 255 || radialBlurDerived[3] !== 255
        || radialBlurSource[0] <= radialBlurSource[2] + 40
        || radialBlurDerived[2] <= radialBlurDerived[0] + 40
        || rgbSum(radialBlurRotatedShadow) >= rgbSum(radialBlurUnrotatedShadowControl) - 20
      ) {
        throw new Error(`Radial Background Blur Repeat did not preserve its half-turn backdrop/effect order: source=${radialBlurSource?.join(",") ?? "missing"} derived=${radialBlurDerived?.join(",") ?? "missing"} rotated-shadow=${radialBlurRotatedShadow?.join(",") ?? "missing"} unrotated-control=${radialBlurUnrotatedShadowControl?.join(",") ?? "missing"}.`);
      }
      append(`Radial Background Blur Repeat Canvas ${radialBlurCanvas.rgbaSha256} sampled source=${radialBlurSource.join(",")}, half-turn derived=${radialBlurDerived.join(",")}, rotated-shadow=${radialBlurRotatedShadow.join(",")} and unrotated-control=${radialBlurUnrotatedShadowControl.join(",")} at revision ${radialBlurRepeatRevision}.`);
      const radialBlurEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > radialBlurRepeatRevision
          && next.nodes.some((node) => node.id === radialBlurRepeat.id)
          && !next.nodes.find((node) => node.id === radialBlurLeaf.id)?.effectStack?.length,
        "Radial Background Blur effect Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialBlurEffectUndone = await radialBlurEffectUndoPromise;
      const radialBlurRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > radialBlurEffectUndone.revision && !next.nodes.some((node) => node.id === radialBlurRepeat.id),
        "Radial Background Blur Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialBlurRepeatUndone = await radialBlurRepeatUndoPromise;
      const radialBlurSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > radialBlurRepeatUndone.revision
          && !next.nodes.some((node) => [radialBlurBackdrop.id, radialBlurSourceStripe.id, radialBlurDerivedStripe.id, radialBlurLeaf.id, radialBlurAnchor.id].includes(node.id)),
        "Radial Background Blur source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialBlurSourceUndone = await radialBlurSourceUndoPromise;
      if (!radialBlurRepeat.removed || !radialBlurBackdrop.removed || !radialBlurSourceStripe.removed || !radialBlurDerivedStripe.removed || !radialBlurLeaf.removed || !radialBlurAnchor.removed) {
        throw new Error("Radial Background Blur Repeat Undo sequence did not retire its wrapper and complete source scenario.");
      }
      append(`Radial Background Blur Repeat Undo sequence passed through revision ${radialBlurSourceUndone.revision}.`);

      const preparedBlurBackdrop = runtime.createRectangle();
      preparedBlurBackdrop.name = "Prepared descendant Background Blur backdrop";
      preparedBlurBackdrop.x = -530;
      preparedBlurBackdrop.y = 315;
      preparedBlurBackdrop.resize(390, 120);
      preparedBlurBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const preparedBlurSourceStripe = runtime.createRectangle();
      preparedBlurSourceStripe.name = "Prepared descendant source backdrop";
      preparedBlurSourceStripe.x = -500;
      preparedBlurSourceStripe.y = 325;
      preparedBlurSourceStripe.resize(40, 100);
      preparedBlurSourceStripe.fills = [{ type: "SOLID", color: { r: .95, g: .1, b: .15 } }];
      const preparedBlurDerivedStripe = runtime.createRectangle();
      preparedBlurDerivedStripe.name = "Prepared descendant derived backdrop";
      preparedBlurDerivedStripe.x = -200;
      preparedBlurDerivedStripe.y = 325;
      preparedBlurDerivedStripe.resize(40, 100);
      preparedBlurDerivedStripe.fills = [{ type: "SOLID", color: { r: .05, g: .2, b: .95 } }];
      const preparedBlurGroup = runtime.createGroup();
      preparedBlurGroup.name = "Prepared Background Blur Group";
      preparedBlurGroup.x = -500;
      preparedBlurGroup.y = 330;
      preparedBlurGroup.resize(40, 85);
      const preparedBlurLocalSibling = runtime.createRectangle();
      preparedBlurLocalSibling.name = "Prepared local backdrop sibling";
      preparedBlurLocalSibling.x = -500;
      preparedBlurLocalSibling.y = 330;
      preparedBlurLocalSibling.resize(40, 30);
      preparedBlurLocalSibling.fills = [{ type: "SOLID", color: { r: .1, g: .9, b: .2 }, opacity: .45 }];
      const preparedBlurLocalLeaf = runtime.createRectangle();
      preparedBlurLocalLeaf.name = "Prepared local plus external Background Blur leaf";
      preparedBlurLocalLeaf.x = -500;
      preparedBlurLocalLeaf.y = 330;
      preparedBlurLocalLeaf.resize(40, 30);
      preparedBlurLocalLeaf.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      const preparedBlurExternalLeaf = runtime.createRectangle();
      preparedBlurExternalLeaf.name = "Prepared external-only Background Blur leaf";
      preparedBlurExternalLeaf.x = -500;
      preparedBlurExternalLeaf.y = 385;
      preparedBlurExternalLeaf.resize(40, 30);
      preparedBlurExternalLeaf.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      preparedBlurGroup.appendChild(preparedBlurLocalSibling);
      preparedBlurGroup.appendChild(preparedBlurLocalLeaf);
      preparedBlurGroup.appendChild(preparedBlurExternalLeaf);
      const preparedBlurSourceRevision = await runtime.commitAsync();
      append(`Prepared descendant Background Blur source committed at revision ${preparedBlurSourceRevision}.`);
      const preparedBlurOwnerEffectPromise = waitForSnapshot(
        (next) => next.revision > preparedBlurSourceRevision
          && Boolean(next.nodes.find((node) => node.id === preparedBlurGroup.id)?.effectStack?.[0]?.layerBlur),
        "prepared Background Blur ancestor effect projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: preparedBlurSourceRevision,
          commands: [{
            type: "update",
            id: preparedBlurGroup.id,
            patch: { effectStack: [{ layerBlur: { visible: true, radius: 1 } }] },
          }],
        },
      } satisfies MainToWorker);
      const preparedBlurOwnerEffectSnapshot = await preparedBlurOwnerEffectPromise;
      append(`Prepared Background Blur ancestor effect committed at revision ${preparedBlurOwnerEffectSnapshot.revision}.`);
      const preparedBlurRepeat = runtime.transformGroup(
        [preparedBlurGroup],
        runtime.currentPage,
        runtime.currentPage.children.length - 1,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      preparedBlurRepeat.name = "Prepared descendant Background Blur Repeat";
      const preparedBlurStructureRevision = await runtime.commitAsync();
      await runtime.currentPage.setSelectionAsync([]);
      const preparedBlurEffectPromise = waitForSnapshot(
        (next) => next.revision > preparedBlurStructureRevision
          && Boolean(next.nodes.find((node) => node.id === preparedBlurLocalLeaf.id)?.effectStack?.[0]?.backgroundBlur)
          && Boolean(next.nodes.find((node) => node.id === preparedBlurExternalLeaf.id)?.effectStack?.[0]?.backgroundBlur),
        "prepared descendant Background Blur effect projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: preparedBlurStructureRevision,
          commands: [preparedBlurLocalLeaf, preparedBlurExternalLeaf].map((leaf) => ({
            type: "update" as const,
            id: leaf.id,
            patch: { effectStack: [{ backgroundBlur: { visible: true, radius: 6 } }] },
          })),
        },
      } satisfies MainToWorker);
      const preparedBlurEffectSnapshot = await preparedBlurEffectPromise;
      const preparedBlurRevision = preparedBlurEffectSnapshot.revision;
      const preparedBlurSvg = await preparedBlurRepeat.exportAsync({ format: "SVG_STRING" });
      if (!preparedBlurSvg.includes('transform="matrix(1 0 0 1 300 0)"')) {
        throw new Error("Prepared descendant Background Blur Repeat did not preserve its source and derived SVG structure.");
      }
      const preparedBlurCanvas = await waitForFrameHash(
        (frame) => frame.revision === preparedBlurRevision,
        "prepared descendant Background Blur Repeat frame hash",
      );
      const preparedLocalSource = preparedBlurCanvas.samples?.find((sample) => sample.label === "repeat-prepared-background-blur-local-source")?.rgba;
      const preparedLocalDerived = preparedBlurCanvas.samples?.find((sample) => sample.label === "repeat-prepared-background-blur-local-derived")?.rgba;
      const preparedExternalSource = preparedBlurCanvas.samples?.find((sample) => sample.label === "repeat-prepared-background-blur-external-source")?.rgba;
      const preparedExternalDerived = preparedBlurCanvas.samples?.find((sample) => sample.label === "repeat-prepared-background-blur-external-derived")?.rgba;
      if (
        !preparedLocalSource || !preparedLocalDerived || !preparedExternalSource || !preparedExternalDerived
        || preparedExternalSource[0] <= preparedExternalSource[2] + 40
        || preparedExternalDerived[2] <= preparedExternalDerived[0] + 40
        || preparedLocalSource[1] <= preparedExternalSource[1] + 30
        || preparedLocalDerived[1] <= preparedExternalDerived[1] + 30
        || [preparedLocalSource, preparedLocalDerived, preparedExternalSource, preparedExternalDerived].some((pixel) => pixel[3] !== 255)
      ) {
        throw new Error(`Prepared descendant Background Blur did not combine local and external backdrops per occurrence: local=${preparedLocalSource?.join(",") ?? "missing"}/${preparedLocalDerived?.join(",") ?? "missing"}, external=${preparedExternalSource?.join(",") ?? "missing"}/${preparedExternalDerived?.join(",") ?? "missing"}.`);
      }
      append(`Prepared descendant Background Blur Canvas ${preparedBlurCanvas.rgbaSha256} combined local=${preparedLocalSource.join(",")}/${preparedLocalDerived.join(",")} and external=${preparedExternalSource.join(",")}/${preparedExternalDerived.join(",")} backdrops at revision ${preparedBlurRevision}.`);
      const preparedBlurEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedBlurRevision
          && next.nodes.some((node) => node.id === preparedBlurRepeat.id)
          && !next.nodes.find((node) => node.id === preparedBlurLocalLeaf.id)?.effectStack?.length
          && !next.nodes.find((node) => node.id === preparedBlurExternalLeaf.id)?.effectStack?.length,
        "prepared descendant Background Blur effect Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedBlurEffectUndone = await preparedBlurEffectUndoPromise;
      const preparedBlurRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedBlurEffectUndone.revision && !next.nodes.some((node) => node.id === preparedBlurRepeat.id),
        "prepared descendant Background Blur Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedBlurRepeatUndone = await preparedBlurRepeatUndoPromise;
      const preparedBlurOwnerEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedBlurRepeatUndone.revision
          && !next.nodes.find((node) => node.id === preparedBlurGroup.id)?.effectStack?.length,
        "prepared Background Blur ancestor effect Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedBlurOwnerEffectUndone = await preparedBlurOwnerEffectUndoPromise;
      const preparedBlurSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedBlurOwnerEffectUndone.revision
          && !next.nodes.some((node) => [preparedBlurBackdrop.id, preparedBlurSourceStripe.id, preparedBlurDerivedStripe.id, preparedBlurGroup.id, preparedBlurLocalSibling.id, preparedBlurLocalLeaf.id, preparedBlurExternalLeaf.id].includes(node.id)),
        "prepared descendant Background Blur source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedBlurSourceUndone = await preparedBlurSourceUndoPromise;
      if (!preparedBlurRepeat.removed || !preparedBlurBackdrop.removed || !preparedBlurSourceStripe.removed || !preparedBlurDerivedStripe.removed || !preparedBlurGroup.removed || !preparedBlurLocalSibling.removed || !preparedBlurLocalLeaf.removed || !preparedBlurExternalLeaf.removed) {
        throw new Error("Prepared descendant Background Blur Undo sequence did not retire its wrapper and complete source subtree.");
      }
      append(`Prepared descendant Background Blur Undo sequence passed through revision ${preparedBlurSourceUndone.revision}.`);

      const maskBackdrop = runtime.createRectangle();
      maskBackdrop.name = "Mask target backdrop";
      maskBackdrop.x = -530;
      maskBackdrop.y = 450;
      maskBackdrop.resize(390, 140);
      maskBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const maskBackdropSourceStripe = runtime.createRectangle();
      maskBackdropSourceStripe.name = "Mask target source backdrop";
      maskBackdropSourceStripe.x = -500;
      maskBackdropSourceStripe.y = 455;
      maskBackdropSourceStripe.resize(40, 130);
      maskBackdropSourceStripe.fills = [{ type: "SOLID", color: { r: .95, g: .1, b: .15 } }];
      const maskBackdropDerivedStripe = runtime.createRectangle();
      maskBackdropDerivedStripe.name = "Mask target derived backdrop";
      maskBackdropDerivedStripe.x = -200;
      maskBackdropDerivedStripe.y = 455;
      maskBackdropDerivedStripe.resize(40, 130);
      maskBackdropDerivedStripe.fills = [{ type: "SOLID", color: { r: .05, g: .2, b: .95 } }];
      const backdropMask = runtime.createRectangle();
      backdropMask.name = "Backdrop-aware target mask";
      backdropMask.x = -500;
      backdropMask.y = 460;
      backdropMask.resize(40, 120);
      backdropMask.fills = [{
        type: "SOLID",
        color: { r: 0, g: 0, b: 0 },
        opacity: 1,
        blendMode: "LINEAR_BURN",
      }];
      const maskedBlurTarget = runtime.createRectangle();
      maskedBlurTarget.name = "Masked Background Blur target";
      maskedBlurTarget.x = -500;
      maskedBlurTarget.y = 465;
      maskedBlurTarget.resize(60, 30);
      maskedBlurTarget.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      const maskedNativeTarget = runtime.createRectangle();
      maskedNativeTarget.name = "Masked Multiply target";
      maskedNativeTarget.x = -500;
      maskedNativeTarget.y = 505;
      maskedNativeTarget.resize(60, 30);
      maskedNativeTarget.fills = [{ type: "SOLID", color: { r: .2, g: .85, b: .35 } }];
      maskedNativeTarget.blendMode = "MULTIPLY";
      const maskedLinearTarget = runtime.createRectangle();
      maskedLinearTarget.name = "Masked Linear Dodge target";
      maskedLinearTarget.x = -500;
      maskedLinearTarget.y = 545;
      maskedLinearTarget.resize(60, 30);
      maskedLinearTarget.fills = [{
        type: "SOLID",
        color: { r: .05, g: .35, b: .08 },
        opacity: 1,
        blendMode: "LINEAR_DODGE",
      }];
      const maskBackdropSourceRevision = await runtime.commitAsync();
      append(`Backdrop-aware mask source committed at revision ${maskBackdropSourceRevision}.`);
      backdropMask.isMask = true;
      const maskBackdropSetMaskRevision = await runtime.commitAsync();
      if (!latestSnapshotRef.current?.nodes.find((node) => node.id === backdropMask.id)?.isMask) {
        throw new Error("Backdrop-aware mask did not survive Runtime SetMask.");
      }
      append(`Backdrop-aware mask Runtime SetMask passed at revision ${maskBackdropSetMaskRevision}.`);
      const maskBackdropRepeat = runtime.transformGroup(
        [backdropMask, maskedBlurTarget, maskedNativeTarget, maskedLinearTarget],
        runtime.currentPage,
        runtime.currentPage.children.length - 4,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 300, axis: "HORIZONTAL" }],
      );
      maskBackdropRepeat.name = "Backdrop-aware mask target Repeat";
      const maskBackdropStructureRevision = await runtime.commitAsync();
      await runtime.currentPage.setSelectionAsync([]);
      const maskBackdropEffectPromise = waitForSnapshot(
        (next) => next.revision > maskBackdropStructureRevision
          && next.nodes.find((node) => node.id === backdropMask.id)?.fillStack?.layers[0]?.blendMode === "linear-burn"
          && Boolean(next.nodes.find((node) => node.id === backdropMask.id)?.effectStack?.[0]?.backgroundBlur)
          && Boolean(next.nodes.find((node) => node.id === maskedBlurTarget.id)?.effectStack?.[0]?.backgroundBlur),
        "mask source and target Background Blur projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: maskBackdropStructureRevision,
          commands: [
            {
              type: "update",
              id: backdropMask.id,
              patch: { effectStack: [{ backgroundBlur: { visible: true, radius: 6 } }] },
            },
            {
              type: "update",
              id: maskedBlurTarget.id,
              patch: { effectStack: [{ backgroundBlur: { visible: true, radius: 6 } }] },
            },
          ],
        },
      } satisfies MainToWorker);
      const maskBackdropEffectSnapshot = await maskBackdropEffectPromise;
      const maskBackdropRevision = maskBackdropEffectSnapshot.revision;
      const maskBackdropSvg = await maskBackdropRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        (maskBackdropSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || !maskBackdropSvg.includes('transform="matrix(1 0 0 1 300 0)"')
      ) throw new Error("Backdrop-aware mask target Repeat did not preserve its two masks and derived SVG matrix.");
      const maskBackdropCanvas = await waitForFrameHash(
        (frame) => frame.revision === maskBackdropRevision,
        "backdrop-aware mask target Repeat frame hash",
      );
      const sample = (label: string) => maskBackdropCanvas.samples?.find((entry) => entry.label === label)?.rgba;
      const blurSource = sample("repeat-mask-backdrop-blur-source");
      const blurDerived = sample("repeat-mask-backdrop-blur-derived");
      const nativeSource = sample("repeat-mask-backdrop-native-source");
      const nativeDerived = sample("repeat-mask-backdrop-native-derived");
      const linearSource = sample("repeat-mask-backdrop-linear-source");
      const linearDerived = sample("repeat-mask-backdrop-linear-derived");
      const outsideSource = sample("repeat-mask-backdrop-outside-source");
      const outsideDerived = sample("repeat-mask-backdrop-outside-derived");
      if (
        !blurSource || !blurDerived || !nativeSource || !nativeDerived
        || !linearSource || !linearDerived || !outsideSource || !outsideDerived
        || blurSource[0] <= blurSource[2] + 40 || blurDerived[2] <= blurDerived[0] + 40
        || nativeSource[0] <= nativeSource[2] + 20 || nativeDerived[2] <= nativeDerived[0] + 20
        || linearSource[0] <= linearSource[2] + 20 || linearDerived[2] <= linearDerived[0] + 20
        || outsideSource.some((channel, index) => Math.abs(channel - [204, 128, 64, 255][index]!) > 2)
        || outsideDerived.some((channel, index) => Math.abs(channel - [204, 128, 64, 255][index]!) > 2)
        || [blurSource, blurDerived, nativeSource, nativeDerived, linearSource, linearDerived].some((pixel) => pixel[3] !== 255)
      ) {
        throw new Error(`Backdrop-aware mask targets did not retain per-occurrence backing and outside alpha: blur=${blurSource?.join(",") ?? "missing"}/${blurDerived?.join(",") ?? "missing"}, native=${nativeSource?.join(",") ?? "missing"}/${nativeDerived?.join(",") ?? "missing"}, linear=${linearSource?.join(",") ?? "missing"}/${linearDerived?.join(",") ?? "missing"}, outside=${outsideSource?.join(",") ?? "missing"}/${outsideDerived?.join(",") ?? "missing"}.`);
      }
      append(`Backdrop-aware mask source-alpha and target Canvas ${maskBackdropCanvas.rgbaSha256} sampled blur=${blurSource.join(",")}/${blurDerived.join(",")}, native=${nativeSource.join(",")}/${nativeDerived.join(",")}, linear=${linearSource.join(",")}/${linearDerived.join(",")} and outside=${outsideSource.join(",")}/${outsideDerived.join(",")} at revision ${maskBackdropRevision}.`);
      const maskBackdropEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > maskBackdropRevision
          && next.nodes.some((node) => node.id === maskBackdropRepeat.id)
          && !next.nodes.find((node) => node.id === backdropMask.id)?.effectStack?.length
          && !next.nodes.find((node) => node.id === maskedBlurTarget.id)?.effectStack?.length,
        "mask source and target Background Blur Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const maskBackdropEffectUndone = await maskBackdropEffectUndoPromise;
      const maskBackdropRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > maskBackdropEffectUndone.revision && !next.nodes.some((node) => node.id === maskBackdropRepeat.id),
        "backdrop-aware mask target Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const maskBackdropRepeatUndone = await maskBackdropRepeatUndoPromise;
      const maskBackdropSetMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > maskBackdropRepeatUndone.revision && !next.nodes.find((node) => node.id === backdropMask.id)?.isMask,
        "backdrop-aware mask target SetMask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const maskBackdropSetMaskUndone = await maskBackdropSetMaskUndoPromise;
      const maskBackdropSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > maskBackdropSetMaskUndone.revision
          && !next.nodes.some((node) => [maskBackdrop.id, maskBackdropSourceStripe.id, maskBackdropDerivedStripe.id, backdropMask.id, maskedBlurTarget.id, maskedNativeTarget.id, maskedLinearTarget.id].includes(node.id)),
        "backdrop-aware mask target source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const maskBackdropSourceUndone = await maskBackdropSourceUndoPromise;
      if (!maskBackdropRepeat.removed || !maskBackdrop.removed || !maskBackdropSourceStripe.removed || !maskBackdropDerivedStripe.removed || !backdropMask.removed || !maskedBlurTarget.removed || !maskedNativeTarget.removed || !maskedLinearTarget.removed) {
        throw new Error("Backdrop-aware mask target Undo sequence did not retire its wrapper and complete source scenario.");
      }
      append(`Backdrop-aware mask target Undo sequence passed through revision ${maskBackdropSourceUndone.revision}.`);

      const radialMaskBackdrop = runtime.createRectangle();
      radialMaskBackdrop.name = "Radial mask target backdrop";
      radialMaskBackdrop.x = -330;
      radialMaskBackdrop.y = -470;
      radialMaskBackdrop.resize(100, 210);
      radialMaskBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const radialMaskSourceStripe = runtime.createRectangle();
      radialMaskSourceStripe.name = "Radial mask target source backdrop";
      radialMaskSourceStripe.x = -300;
      radialMaskSourceStripe.y = -440;
      radialMaskSourceStripe.resize(40, 30);
      radialMaskSourceStripe.fills = [{ type: "SOLID", color: { r: .95, g: .1, b: .15 } }];
      const radialMaskDerivedStripe = runtime.createRectangle();
      radialMaskDerivedStripe.name = "Radial mask target derived backdrop";
      radialMaskDerivedStripe.x = -300;
      radialMaskDerivedStripe.y = -320;
      radialMaskDerivedStripe.resize(40, 30);
      radialMaskDerivedStripe.fills = [{ type: "SOLID", color: { r: .05, g: .2, b: .95 } }];
      const radialBackdropMask = runtime.createRectangle();
      radialBackdropMask.name = "Radial backdrop-aware target mask";
      radialBackdropMask.x = -300;
      radialBackdropMask.y = -440;
      radialBackdropMask.resize(40, 30);
      radialBackdropMask.fills = [{
        type: "SOLID",
        color: { r: 0, g: 0, b: 0 },
        opacity: 1,
        blendMode: "LINEAR_DODGE",
      }];
      const radialMaskedBlurTarget = runtime.createRectangle();
      radialMaskedBlurTarget.name = "Radial masked Background Blur target";
      radialMaskedBlurTarget.x = -300;
      radialMaskedBlurTarget.y = -440;
      radialMaskedBlurTarget.resize(40, 30);
      radialMaskedBlurTarget.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      const radialMaskAnchor = runtime.createRectangle();
      radialMaskAnchor.name = "Radial mask target geometry anchor";
      radialMaskAnchor.x = -300;
      radialMaskAnchor.y = -320;
      radialMaskAnchor.resize(40, 30);
      radialMaskAnchor.fills = [];
      const radialMaskSourceRevision = await runtime.commitAsync();
      radialBackdropMask.isMask = true;
      const radialMaskSetMaskRevision = await runtime.commitAsync();
      append(`Radial backdrop-aware mask source and SetMask committed through revision ${radialMaskSetMaskRevision}.`);
      const radialMaskRepeat = runtime.transformGroup(
        [radialBackdropMask, radialMaskedBlurTarget, radialMaskAnchor],
        runtime.currentPage,
        runtime.currentPage.children.length - 3,
        [{ type: "REPEAT", repeatType: "RADIAL", count: 1, unitType: "PIXELS", offset: 120 }],
      );
      radialMaskRepeat.name = "Radial backdrop-aware mask target Repeat";
      const radialMaskStructureRevision = await runtime.commitAsync();
      await runtime.currentPage.setSelectionAsync([]);
      const radialMaskEffectPromise = waitForSnapshot(
        (next) => next.revision > radialMaskStructureRevision
          && next.nodes.find((node) => node.id === radialBackdropMask.id)?.fillStack?.layers[0]?.blendMode === "linear-dodge"
          && Boolean(next.nodes.find((node) => node.id === radialBackdropMask.id)?.effectStack?.[0]?.backgroundBlur)
          && Boolean(next.nodes.find((node) => node.id === radialMaskedBlurTarget.id)?.effectStack?.[0]?.backgroundBlur),
        "radial mask source and target Background Blur projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: radialMaskStructureRevision,
          commands: [
            {
              type: "update",
              id: radialBackdropMask.id,
              patch: { effectStack: [{ backgroundBlur: { visible: true, radius: 6 } }] },
            },
            {
              type: "update",
              id: radialMaskedBlurTarget.id,
              patch: { effectStack: [{ backgroundBlur: { visible: true, radius: 6 } }] },
            },
          ],
        },
      } satisfies MainToWorker);
      const radialMaskEffectSnapshot = await radialMaskEffectPromise;
      const radialMaskRevision = radialMaskEffectSnapshot.revision;
      const radialMaskSvg = await radialMaskRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        (radialMaskSvg.match(/<mask /gu)?.length ?? 0) !== 2
        || !radialMaskSvg.includes('transform="matrix(-1 0 0 -1')
      ) throw new Error("Radial backdrop-aware mask target Repeat did not preserve its two masks and half-turn SVG matrix.");
      const radialMaskCanvas = await waitForFrameHash(
        (frame) => frame.revision === radialMaskRevision,
        "radial backdrop-aware mask target Repeat frame hash",
      );
      const radialMaskSource = radialMaskCanvas.samples?.find((entry) => entry.label === "repeat-radial-mask-backdrop-source")?.rgba;
      const radialMaskDerived = radialMaskCanvas.samples?.find((entry) => entry.label === "repeat-radial-mask-backdrop-derived")?.rgba;
      if (
        !radialMaskSource || !radialMaskDerived
        || radialMaskSource[0] <= radialMaskSource[2] + 40
        || radialMaskDerived[2] <= radialMaskDerived[0] + 40
        || radialMaskSource[3] !== 255 || radialMaskDerived[3] !== 255
      ) throw new Error(`Radial backdrop-aware mask target did not read its half-turn occurrence backing: ${radialMaskSource?.join(",") ?? "missing"}/${radialMaskDerived?.join(",") ?? "missing"}.`);
      append(`Radial backdrop-aware mask source-alpha and target Canvas ${radialMaskCanvas.rgbaSha256} sampled source=${radialMaskSource.join(",")} and half-turn derived=${radialMaskDerived.join(",")} at revision ${radialMaskRevision}.`);
      const radialMaskEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > radialMaskRevision
          && next.nodes.some((node) => node.id === radialMaskRepeat.id)
          && !next.nodes.find((node) => node.id === radialBackdropMask.id)?.effectStack?.length
          && !next.nodes.find((node) => node.id === radialMaskedBlurTarget.id)?.effectStack?.length,
        "radial mask source and target Background Blur Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialMaskEffectUndone = await radialMaskEffectUndoPromise;
      const radialMaskRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > radialMaskEffectUndone.revision && !next.nodes.some((node) => node.id === radialMaskRepeat.id),
        "radial backdrop-aware mask target Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialMaskRepeatUndone = await radialMaskRepeatUndoPromise;
      const radialMaskSetMaskUndoPromise = waitForSnapshot(
        (next) => next.revision > radialMaskRepeatUndone.revision && !next.nodes.find((node) => node.id === radialBackdropMask.id)?.isMask,
        "radial backdrop-aware mask target SetMask Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialMaskSetMaskUndone = await radialMaskSetMaskUndoPromise;
      const radialMaskSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > radialMaskSetMaskUndone.revision
          && !next.nodes.some((node) => [radialMaskBackdrop.id, radialMaskSourceStripe.id, radialMaskDerivedStripe.id, radialBackdropMask.id, radialMaskedBlurTarget.id, radialMaskAnchor.id].includes(node.id)),
        "radial backdrop-aware mask target source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const radialMaskSourceUndone = await radialMaskSourceUndoPromise;
      if (!radialMaskRepeat.removed || !radialMaskBackdrop.removed || !radialMaskSourceStripe.removed || !radialMaskDerivedStripe.removed || !radialBackdropMask.removed || !radialMaskedBlurTarget.removed || !radialMaskAnchor.removed || radialMaskSourceRevision >= radialMaskSetMaskRevision) {
        throw new Error("Radial backdrop-aware mask target Undo sequence did not retire its wrapper and complete source scenario.");
      }
      append(`Radial backdrop-aware mask target Undo sequence passed through revision ${radialMaskSourceUndone.revision}.`);

      const preparedOwnerBackdrop = runtime.createRectangle();
      preparedOwnerBackdrop.name = "Prepared owner presentation backdrop";
      preparedOwnerBackdrop.x = 150;
      preparedOwnerBackdrop.y = -540;
      preparedOwnerBackdrop.resize(350, 150);
      preparedOwnerBackdrop.fills = [{ type: "SOLID", color: { r: .8, g: .5, b: .25 } }];
      const preparedOwnerSourceStripe = runtime.createRectangle();
      preparedOwnerSourceStripe.name = "Prepared owner source backdrop";
      preparedOwnerSourceStripe.x = 180;
      preparedOwnerSourceStripe.y = -530;
      preparedOwnerSourceStripe.resize(40, 130);
      preparedOwnerSourceStripe.fills = [{ type: "SOLID", color: { r: .95, g: .1, b: .15 } }];
      const preparedOwnerDerivedStripe = runtime.createRectangle();
      preparedOwnerDerivedStripe.name = "Prepared owner derived backdrop";
      preparedOwnerDerivedStripe.x = 440;
      preparedOwnerDerivedStripe.y = -530;
      preparedOwnerDerivedStripe.resize(40, 130);
      preparedOwnerDerivedStripe.fills = [{ type: "SOLID", color: { r: .05, g: .2, b: .95 } }];
      const preparedNormalGroup = runtime.createGroup();
      preparedNormalGroup.name = "Prepared translucent NORMAL ancestor";
      preparedNormalGroup.x = 180;
      preparedNormalGroup.y = -515;
      preparedNormalGroup.resize(40, 50);
      const preparedNormalLeaf = runtime.createRectangle();
      preparedNormalLeaf.name = "Prepared NORMAL descendant Background Blur";
      preparedNormalLeaf.x = 180;
      preparedNormalLeaf.y = -515;
      preparedNormalLeaf.resize(40, 50);
      preparedNormalLeaf.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      preparedNormalGroup.appendChild(preparedNormalLeaf);
      const preparedMultiplyGroup = runtime.createGroup();
      preparedMultiplyGroup.name = "Prepared translucent Multiply ancestor";
      preparedMultiplyGroup.x = 180;
      preparedMultiplyGroup.y = -445;
      preparedMultiplyGroup.resize(40, 50);
      const preparedMultiplyLeaf = runtime.createRectangle();
      preparedMultiplyLeaf.name = "Prepared Multiply descendant Background Blur";
      preparedMultiplyLeaf.x = 180;
      preparedMultiplyLeaf.y = -445;
      preparedMultiplyLeaf.resize(40, 50);
      preparedMultiplyLeaf.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: .12 }];
      preparedMultiplyGroup.appendChild(preparedMultiplyLeaf);
      const preparedOwnerSourceRevision = await runtime.commitAsync();
      append(`Prepared owner-presentation source committed at revision ${preparedOwnerSourceRevision}.`);
      const preparedOwnerPresentationPromise = waitForSnapshot(
        (next) => {
          const normal = next.nodes.find((node) => node.id === preparedNormalGroup.id);
          const multiply = next.nodes.find((node) => node.id === preparedMultiplyGroup.id);
          return next.revision > preparedOwnerSourceRevision
            && normal?.opacity === .65
            && normal.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION]?.[0] === 1
            && multiply?.opacity === .65
            && multiply.blendMode === "multiply";
        },
        "prepared owner opacity, NORMAL isolation and Multiply projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: preparedOwnerSourceRevision,
          commands: [
            {
              type: "update",
              id: preparedNormalGroup.id,
              patch: {
                opacity: .65,
                extensions: { [NORMAL_BLEND_ISOLATION_EXTENSION]: [1] },
              },
            },
            {
              type: "update",
              id: preparedMultiplyGroup.id,
              patch: { opacity: .65, blendMode: "multiply" },
            },
          ],
        },
      } satisfies MainToWorker);
      const preparedOwnerPresentation = await preparedOwnerPresentationPromise;
      append(`Prepared owner opacity, NORMAL isolation and Multiply committed at revision ${preparedOwnerPresentation.revision}.`);
      const preparedOwnerRepeat = runtime.transformGroup(
        [preparedNormalGroup, preparedMultiplyGroup],
        runtime.currentPage,
        runtime.currentPage.children.length - 2,
        [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 260, axis: "HORIZONTAL" }],
      );
      preparedOwnerRepeat.name = "Prepared owner-presentation Background Blur Repeat";
      const preparedOwnerRepeatRevision = await runtime.commitAsync();
      await runtime.currentPage.setSelectionAsync([]);
      const preparedOwnerEffectPromise = waitForSnapshot(
        (next) => next.revision > preparedOwnerRepeatRevision
          && Boolean(next.nodes.find((node) => node.id === preparedNormalLeaf.id)?.effectStack?.[0]?.backgroundBlur)
          && Boolean(next.nodes.find((node) => node.id === preparedMultiplyLeaf.id)?.effectStack?.[0]?.backgroundBlur),
        "prepared owner descendant Background Blur projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: preparedOwnerRepeatRevision,
          commands: [preparedNormalLeaf, preparedMultiplyLeaf].map((leaf) => ({
            type: "update" as const,
            id: leaf.id,
            patch: { effectStack: [{ backgroundBlur: { visible: true, radius: 6 } }] },
          })),
        },
      } satisfies MainToWorker);
      const preparedOwnerEffectSnapshot = await preparedOwnerEffectPromise;
      const preparedOwnerSvg = await preparedOwnerRepeat.exportAsync({ format: "SVG_STRING" });
      if (
        !preparedOwnerSvg.includes('transform="matrix(1 0 0 1 260 0)"')
        || (preparedOwnerSvg.match(/opacity="0.65"/gu)?.length ?? 0) !== 4
        || (preparedOwnerSvg.match(/style="isolation:isolate"/gu)?.length ?? 0) !== 2
        || (preparedOwnerSvg.match(/style="mix-blend-mode:multiply"/gu)?.length ?? 0) !== 2
      ) throw new Error("Prepared owner-presentation Repeat did not preserve opacity, NORMAL isolation, Multiply and derived SVG structure.");
      const preparedOwnerCanvas = await waitForFrameHash(
        (frame) => frame.revision === preparedOwnerEffectSnapshot.revision,
        "prepared owner-presentation Background Blur frame hash",
      );
      const preparedOwnerSamples = [
        "repeat-prepared-owner-normal-source",
        "repeat-prepared-owner-normal-derived",
        "repeat-prepared-owner-multiply-source",
        "repeat-prepared-owner-multiply-derived",
      ].map((label) => preparedOwnerCanvas.samples?.find((sample) => sample.label === label)?.rgba);
      const [normalSource, normalDerived, multiplySource, multiplyDerived] = preparedOwnerSamples;
      if (
        preparedOwnerSamples.some((sample) => !sample || sample[3] !== 255)
        || normalSource![0] <= normalSource![2] + 40
        || normalDerived![2] <= normalDerived![0] + 40
        || multiplySource![0] <= multiplySource![2] + 20
        || multiplyDerived![2] <= multiplyDerived![0] + 20
        || normalSource!.every((value, index) => value === multiplySource![index])
        || normalDerived!.every((value, index) => value === multiplyDerived![index])
      ) throw new Error(`Prepared owner-presentation Background Blur probes were not occurrence- and owner-sensitive: ${preparedOwnerSamples.map((sample) => sample?.join(",") ?? "missing").join("/")}.`);
      append(`Prepared owner-presentation Background Blur Canvas ${preparedOwnerCanvas.rgbaSha256} sampled NORMAL=${normalSource!.join(",")}/${normalDerived!.join(",")} and Multiply=${multiplySource!.join(",")}/${multiplyDerived!.join(",")} at revision ${preparedOwnerEffectSnapshot.revision}.`);
      const preparedOwnerEffectUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedOwnerEffectSnapshot.revision
          && next.nodes.some((node) => node.id === preparedOwnerRepeat.id)
          && !next.nodes.find((node) => node.id === preparedNormalLeaf.id)?.effectStack?.length
          && !next.nodes.find((node) => node.id === preparedMultiplyLeaf.id)?.effectStack?.length,
        "prepared owner descendant Background Blur Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedOwnerEffectUndone = await preparedOwnerEffectUndoPromise;
      const preparedOwnerRepeatUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedOwnerEffectUndone.revision && !next.nodes.some((node) => node.id === preparedOwnerRepeat.id),
        "prepared owner Repeat Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedOwnerRepeatUndone = await preparedOwnerRepeatUndoPromise;
      const preparedOwnerPresentationUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedOwnerRepeatUndone.revision
          && next.nodes.find((node) => node.id === preparedNormalGroup.id)?.opacity === 1
          && next.nodes.find((node) => node.id === preparedNormalGroup.id)?.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION] === undefined
          && next.nodes.find((node) => node.id === preparedMultiplyGroup.id)?.opacity === 1
          && next.nodes.find((node) => node.id === preparedMultiplyGroup.id)?.blendMode !== "multiply",
        "prepared owner presentation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedOwnerPresentationUndone = await preparedOwnerPresentationUndoPromise;
      const preparedOwnerSourceUndoPromise = waitForSnapshot(
        (next) => next.revision > preparedOwnerPresentationUndone.revision
          && !next.nodes.some((node) => [
            preparedOwnerBackdrop.id,
            preparedOwnerSourceStripe.id,
            preparedOwnerDerivedStripe.id,
            preparedNormalGroup.id,
            preparedNormalLeaf.id,
            preparedMultiplyGroup.id,
            preparedMultiplyLeaf.id,
          ].includes(node.id)),
        "prepared owner source Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const preparedOwnerSourceUndone = await preparedOwnerSourceUndoPromise;
      if (!preparedOwnerRepeat.removed
        || !preparedOwnerBackdrop.removed
        || !preparedOwnerSourceStripe.removed
        || !preparedOwnerDerivedStripe.removed
        || !preparedNormalGroup.removed
        || !preparedNormalLeaf.removed
        || !preparedMultiplyGroup.removed
        || !preparedMultiplyLeaf.removed) {
        throw new Error("Prepared owner-presentation Undo sequence did not retire the wrapper and complete source scenario.");
      }
      append(`Prepared owner-presentation Undo sequence passed through revision ${preparedOwnerSourceUndone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown special-node harness failure.");
    }
  };

  const runShapeWithTextParagraphScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      worker.postMessage({ type: "resize", width: 800, height: 500, dpr: 1 } satisfies MainToWorker);
      const shape = runtime.createShapeWithText();
      shape.name = "Shape paragraph layout";
      shape.x = 20;
      shape.y = 20;
      shape.resize(320, 180);
      shape.text.fontSize = 20;
      shape.text.characters = "First\nSecond";
      shape.text.lineHeight = { value: 24, unit: "PIXELS" };
      shape.text.paragraphSpacing = 6;
      const initialLineHeight = shape.text.lineHeight;
      if (
        initialLineHeight.unit !== "PIXELS"
        || initialLineHeight.value !== 24
        || shape.text.paragraphSpacing !== 6
      ) throw new Error("ShapeWithText paragraph properties did not provide read-your-writes before Ack.");

      const initialRevision = await runtime.commitAsync();
      const initialFrame = await waitForFrameHash(
        (frame) => frame.revision === initialRevision,
        "initial ShapeWithText paragraph frame hash",
      );
      const initialParagraph = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph;
      if (initialParagraph?.lineHeight !== 24 || initialParagraph.paragraphSpacing !== 6) {
        throw new Error("Worker/Core did not persist the initial ShapeWithText paragraph properties.");
      }

      shape.text.setRangeLineHeight(0, shape.text.characters.length, { value: 200, unit: "PERCENT" });
      shape.text.setRangeParagraphSpacing(0, shape.text.characters.length, 18);
      const percentRevision = await runtime.commitAsync();
      const percentFrame = await waitForFrameHash(
        (frame) => frame.revision === percentRevision,
        "PERCENT ShapeWithText paragraph frame hash",
      );
      const percentParagraph = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph;
      if (percentParagraph?.lineHeight !== 200 || percentParagraph.lineHeightUnit !== "percent" || percentParagraph.paragraphSpacing !== 18) {
        throw new Error("Worker/Core did not persist the PERCENT ShapeWithText line height.");
      }
      if (percentFrame.rgbaSha256 === initialFrame.rgbaSha256) {
        throw new Error("PERCENT ShapeWithText line height did not change the real Worker Canvas frame.");
      }
      const percentSvg = await shape.exportAsync({ format: "SVG_STRING" });
      if (!percentSvg.includes('y="61"') || !percentSvg.includes('y="119"')) {
        throw new Error("Frozen SVG did not resolve the 200% line height to 40px.");
      }

      shape.text.lineHeight = { unit: "AUTO" };
      if (shape.text.lineHeight.unit !== "AUTO") throw new Error("AUTO line height was not readable before Ack.");
      const autoRevision = await runtime.commitAsync();
      const autoFrame = await waitForFrameHash(
        (frame) => frame.revision === autoRevision,
        "AUTO ShapeWithText paragraph frame hash",
      );
      const autoParagraph = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph;
      if (autoParagraph?.lineHeight !== undefined || autoParagraph?.lineHeightUnit !== "auto") {
        throw new Error("Worker/Core did not persist the AUTO ShapeWithText line height.");
      }
      if (autoFrame.rgbaSha256 === percentFrame.rgbaSha256) {
        throw new Error("AUTO and PERCENT line heights produced the same Worker Canvas frame.");
      }

      shape.text.setRangeParagraphIndent(0, shape.text.characters.length, 36);
      if (shape.text.paragraphIndent !== 36 || shape.text.getRangeParagraphIndent(0, 1) !== 36) {
        throw new Error("ShapeWithText paragraphIndent did not provide read-your-writes before Ack.");
      }
      const indentRevision = await runtime.commitAsync();
      const indentFrame = await waitForFrameHash(
        (frame) => frame.revision === indentRevision,
        "indented ShapeWithText paragraph frame hash",
      );
      const indentParagraph = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph;
      if (indentParagraph?.paragraphIndent !== 36) {
        throw new Error("Worker/Core did not persist ShapeWithText paragraphIndent.");
      }
      if (indentFrame.rgbaSha256 === autoFrame.rgbaSha256) {
        throw new Error("ShapeWithText paragraphIndent did not change the real Worker Canvas frame.");
      }
      const indentSvg = await shape.exportAsync({ format: "SVG_STRING" });
      if (Array.from(indentSvg.matchAll(/x="46"/gu)).length < 2) {
        throw new Error("Frozen SVG did not indent the first visual line of each hard paragraph.");
      }

      const pendingBeforeInvalid = runtime.session.projectionStore.pendingTransactionIds().length;
      let partialRangeRejected = false;
      try {
        shape.text.setRangeParagraphSpacing(0, 1, 4);
      } catch (error) {
        partialRangeRejected = isRuntimeError(error, "UNSUPPORTED_FEATURE");
      }
      if (
        !partialRangeRejected
        || runtime.session.projectionStore.pendingTransactionIds().length !== pendingBeforeInvalid
      ) throw new Error("Partial multi-paragraph writes were not rejected before staging.");
      let invalidIndentRejected = false;
      try {
        shape.text.paragraphIndent = -1;
      } catch (error) {
        invalidIndentRejected = isRuntimeError(error, "INVALID_ARGUMENT");
      }
      if (
        !invalidIndentRejected
        || runtime.session.projectionStore.pendingTransactionIds().length !== pendingBeforeInvalid
      ) throw new Error("Invalid paragraphIndent was not rejected before staging.");

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > indentRevision
          && snapshot.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph.lineHeight === undefined
          && snapshot.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph.lineHeightUnit === "auto"
          && snapshot.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph.paragraphIndent === undefined,
        "ShapeWithText paragraph Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const undoFrame = await waitForFrameHash(
        (frame) => frame.revision === undone.revision,
        "ShapeWithText paragraph Undo frame hash",
      );
      if (undoFrame.rgbaSha256 !== autoFrame.rgbaSha256) {
        throw new Error("ShapeWithText paragraph Undo did not restore the exact unindented Canvas frame.");
      }

      const redoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > undone.revision
          && snapshot.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph.lineHeight === undefined
          && snapshot.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph.lineHeightUnit === "auto"
          && snapshot.nodes.find((node) => node.id === shape.id)?.textProperties?.paragraph.paragraphIndent === 36,
        "ShapeWithText paragraph Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const redone = await redoPromise;
      const redoFrame = await waitForFrameHash(
        (frame) => frame.revision === redone.revision,
        "ShapeWithText paragraph Redo frame hash",
      );
      if (redoFrame.rgbaSha256 !== indentFrame.rgbaSha256) {
        throw new Error("ShapeWithText paragraph Redo did not restore the exact indented Canvas frame.");
      }

      const wrapShape = runtime.createShapeWithText();
      wrapShape.name = "Shape balanced wrapping";
      wrapShape.x = 380;
      wrapShape.y = 20;
      wrapShape.resize(130, 180);
      wrapShape.text.fontSize = 20;
      wrapShape.text.characters = "AA BB CC DD";
      wrapShape.text.lineHeight = { value: 24, unit: "PIXELS" };
      if (wrapShape.text.textWrapStyle !== "AUTO") throw new Error("ShapeWithText default textWrapStyle was not AUTO.");
      const wrapAutoRevision = await runtime.commitAsync();
      const wrapAutoFrame = await waitForFrameHash(
        (frame) => frame.revision === wrapAutoRevision,
        "AUTO ShapeWithText wrap frame hash",
      );
      const wrapAutoSvg = await wrapShape.exportAsync({ format: "SVG_STRING" });
      if (!wrapAutoSvg.includes(">AA BB CC</tspan>") || !wrapAutoSvg.includes(">DD</tspan>")) {
        throw new Error("Frozen SVG did not preserve AUTO greedy wrapping.");
      }

      wrapShape.text.setRangeTextWrapStyle(0, wrapShape.text.characters.length, "BALANCE");
      if (String(wrapShape.text.textWrapStyle) !== "BALANCE" || wrapShape.text.getRangeTextWrapStyle(0, 1) !== "BALANCE") {
        throw new Error("ShapeWithText BALANCE did not provide read-your-writes before Ack.");
      }
      const balanceRevision = await runtime.commitAsync();
      const balanceFrame = await waitForFrameHash(
        (frame) => frame.revision === balanceRevision,
        "BALANCE ShapeWithText wrap frame hash",
      );
      if (latestSnapshotRef.current?.nodes.find((node) => node.id === wrapShape.id)?.textProperties?.paragraph.textWrapStyle !== "balance") {
        throw new Error("Worker/Core did not persist BALANCE textWrapStyle.");
      }
      if (balanceFrame.rgbaSha256 === wrapAutoFrame.rgbaSha256) {
        throw new Error("BALANCE textWrapStyle did not change the real Worker Canvas frame.");
      }
      const balanceSvg = await wrapShape.exportAsync({ format: "SVG_STRING" });
      if (!balanceSvg.includes(">AA BB</tspan>") || !balanceSvg.includes(">CC DD</tspan>") || balanceSvg.includes(">AA BB CC</tspan>")) {
        throw new Error("Frozen SVG did not equalize BALANCE line lengths.");
      }

      wrapShape.text.textWrapStyle = "PRETTY";
      const prettyRevision = await runtime.commitAsync();
      const prettyFrame = await waitForFrameHash(
        (frame) => frame.revision === prettyRevision,
        "PRETTY ShapeWithText wrap frame hash",
      );
      if (latestSnapshotRef.current?.nodes.find((node) => node.id === wrapShape.id)?.textProperties?.paragraph.textWrapStyle !== "pretty") {
        throw new Error("Worker/Core did not persist PRETTY textWrapStyle.");
      }
      if (prettyFrame.rgbaSha256 !== balanceFrame.rgbaSha256) {
        throw new Error("PRETTY did not remove the fixture orphan using the balanced two-line layout.");
      }
      const pendingBeforeInvalidWrap = runtime.session.projectionStore.pendingTransactionIds().length;
      let invalidWrapRejected = false;
      try {
        (wrapShape.text as unknown as { textWrapStyle: string }).textWrapStyle = "STABLE";
      } catch (error) {
        invalidWrapRejected = isRuntimeError(error, "INVALID_ARGUMENT");
      }
      if (!invalidWrapRejected || runtime.session.projectionStore.pendingTransactionIds().length !== pendingBeforeInvalidWrap) {
        throw new Error("Unknown textWrapStyle was not rejected before staging.");
      }

      const undoPrettyPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > prettyRevision
          && snapshot.nodes.find((node) => node.id === wrapShape.id)?.textProperties?.paragraph.textWrapStyle === "balance",
        "ShapeWithText PRETTY Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const prettyUndone = await undoPrettyPromise;
      const undoPrettyFrame = await waitForFrameHash(
        (frame) => frame.revision === prettyUndone.revision,
        "ShapeWithText PRETTY Undo frame hash",
      );
      if (undoPrettyFrame.rgbaSha256 !== balanceFrame.rgbaSha256) throw new Error("Undo did not restore BALANCE frame bytes.");

      const undoBalancePromise = waitForSnapshot(
        (snapshot) => snapshot.revision > prettyUndone.revision
          && snapshot.nodes.find((node) => node.id === wrapShape.id)?.textProperties?.paragraph.textWrapStyle === undefined,
        "ShapeWithText BALANCE Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const balanceUndone = await undoBalancePromise;
      const undoBalanceFrame = await waitForFrameHash(
        (frame) => frame.revision === balanceUndone.revision,
        "ShapeWithText BALANCE Undo frame hash",
      );
      if (undoBalanceFrame.rgbaSha256 !== wrapAutoFrame.rgbaSha256) throw new Error("Undo did not restore AUTO frame bytes.");

      const redoBalancePromise = waitForSnapshot(
        (snapshot) => snapshot.revision > balanceUndone.revision
          && snapshot.nodes.find((node) => node.id === wrapShape.id)?.textProperties?.paragraph.textWrapStyle === "balance",
        "ShapeWithText BALANCE Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const balanceRedone = await redoBalancePromise;
      const redoBalanceFrame = await waitForFrameHash(
        (frame) => frame.revision === balanceRedone.revision,
        "ShapeWithText BALANCE Redo frame hash",
      );
      if (redoBalanceFrame.rgbaSha256 !== balanceFrame.rgbaSha256) throw new Error("Redo did not restore BALANCE frame bytes.");

      const redoPrettyPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > balanceRedone.revision
          && snapshot.nodes.find((node) => node.id === wrapShape.id)?.textProperties?.paragraph.textWrapStyle === "pretty",
        "ShapeWithText PRETTY Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const prettyRedone = await redoPrettyPromise;
      const redoPrettyFrame = await waitForFrameHash(
        (frame) => frame.revision === prettyRedone.revision,
        "ShapeWithText PRETTY Redo frame hash",
      );
      if (redoPrettyFrame.rgbaSha256 !== prettyFrame.rgbaSha256) throw new Error("Redo did not restore PRETTY frame bytes.");

      append(`ShapeWithText lineHeight resolved PIXELS/PERCENT/AUTO Canvas ${initialFrame.rgbaSha256} → ${percentFrame.rgbaSha256} → ${autoFrame.rgbaSha256}; paragraphIndent produced ${indentFrame.rgbaSha256}; textWrapStyle AUTO/BALANCE/PRETTY produced ${wrapAutoFrame.rgbaSha256} → ${balanceFrame.rgbaSha256} → ${prettyFrame.rgbaSha256}; Undo/Redo restored exact frames through revision ${prettyRedone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown ShapeWithText paragraph harness failure.");
    }
  };

  const runTextRangeScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const repeated = runtime.createText();
      repeated.name = "Repeated styled text";
      repeated.x = 40;
      repeated.y = 60;
      repeated.resize(320, 80);
      repeated.characters = "aaaa";
      repeated.setRangeFontSize(0, 1, 12);
      repeated.setRangeFontSize(1, 3, 20);
      repeated.setRangeFontSize(3, 4, 30);

      const emoji = runtime.createText();
      emoji.name = "Unicode range guard";
      emoji.x = 40;
      emoji.y = 180;
      emoji.characters = "A😀中";
      let splitRejected = false;
      try {
        emoji.insertCharacters(2, "x");
      } catch (error) {
        splitRejected = isRuntimeError(error, "INVALID_ARGUMENT");
      }
      const pendingRuns = (runtime.session.projectionStore.getNode(repeated.id)?.textProperties as { runs?: Array<{ start: number; end: number; fontSize: number }> } | undefined)?.runs;
      if (
        !splitRejected || emoji.characters !== "A😀中"
        || JSON.stringify(pendingRuns?.map(({ start, end, fontSize }) => ({ start, end, fontSize }))) !== JSON.stringify([
          { start: 0, end: 1, fontSize: 12 },
          { start: 1, end: 3, fontSize: 20 },
          { start: 3, end: 4, fontSize: 30 },
        ])
      ) throw new Error("Pending text ranges lost their explicit run or Unicode boundary semantics.");
      append("Pending mixed runs and surrogate-pair rejection passed before Ack.");

      const createdRevision = await runtime.commitAsync();
      const confirmedCreated = latestSnapshotRef.current?.nodes.find((node) => node.id === repeated.id);
      if (confirmedCreated?.text !== "aaaa" || confirmedCreated.textProperties?.runs.length !== 3) {
        throw new Error("Worker/Core did not preserve the initial mixed text runs.");
      }
      append(`Mixed text creation fence passed at revision ${createdRevision}.`);

      repeated.insertCharacters(2, "a");
      const insertedRuns = (runtime.session.projectionStore.getNode(repeated.id)?.textProperties as { runs?: Array<{ start: number; end: number; fontSize: number }> } | undefined)?.runs;
      if (
        repeated.characters !== "aaaaa"
        || JSON.stringify(insertedRuns?.map(({ start, end, fontSize }) => ({ start, end, fontSize }))) !== JSON.stringify([
          { start: 0, end: 1, fontSize: 12 },
          { start: 1, end: 4, fontSize: 20 },
          { start: 4, end: 5, fontSize: 30 },
        ])
      ) throw new Error("Repeated-text insertion inherited the wrong explicit style run.");
      append("Repeated-text insertion preserved the requested middle run before Ack.");

      const insertedRevision = await runtime.commitAsync();
      const confirmedInserted = latestSnapshotRef.current?.nodes.find((node) => node.id === repeated.id);
      const confirmedRuns = confirmedInserted?.textProperties?.runs.map(({ start, end, fontSize }) => ({ start, end, fontSize }));
      if (
        confirmedInserted?.text !== "aaaaa"
        || JSON.stringify(confirmedRuns) !== JSON.stringify([
          { start: 0, end: 1, fontSize: 12 },
          { start: 1, end: 4, fontSize: 20 },
          { start: 4, end: 5, fontSize: 30 },
        ])
      ) throw new Error("Confirmed repeated-text insertion changed its explicit style run.");
      const textSvg = await repeated.exportAsync({ format: "SVG_STRING" });
      if (
        !textSvg.includes('font-size="12"')
        || !textSvg.includes('font-size="20"')
        || !textSvg.includes('font-size="30"')
        || !textSvg.includes(">aaa</tspan>")
      ) throw new Error("Frozen SVG did not preserve the confirmed mixed text runs.");
      append(`Confirmed range insertion and mixed-run SVG passed at revision ${insertedRevision}.`);

      const insertionUndoPromise = waitForSnapshot(
        (next) => next.revision > insertedRevision && next.nodes.some((node) => node.id === repeated.id && node.text === "aaaa" && node.textProperties?.runs.length === 3),
        "text range insertion Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const insertionUndone = await insertionUndoPromise;
      if (runtime.session.projectionStore.getNode(repeated.id)?.characters !== "aaaa") throw new Error("Undo did not restore the original repeated text.");
      append(`Text range insertion Undo passed at revision ${insertionUndone.revision}.`);

      const creationUndoPromise = waitForSnapshot(
        (next) => next.revision > insertionUndone.revision && !next.nodes.some((node) => node.id === repeated.id || node.id === emoji.id),
        "mixed text creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const creationUndone = await creationUndoPromise;
      if (!repeated.removed || !emoji.removed) throw new Error("Undo did not retire the mixed text proxies.");
      append(`Mixed text creation Undo retired both proxies at revision ${creationUndone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown text range harness failure.");
    }
  };

  const runEmptyTextBaseStyleScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const shape = runtime.createShapeWithText();
      shape.name = "Empty base style";
      shape.x = 260;
      shape.y = 180;
      shape.resize(260, 120);
      const text = shape.text;
      text.fontSize = 24;
      text.letterSpacing = { value: 1.5, unit: "PIXELS" };
      text.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75 }];
      const emptyFills = text.fills;
      const emptyLetterSpacing = text.letterSpacing;
      if (
        text.characters !== "" || text.fontSize !== 24
        || emptyLetterSpacing.value !== 1.5
        || emptyFills.length !== 1
        || emptyFills[0]?.type !== "SOLID" || emptyFills[0].color.r !== 1 || emptyFills[0].opacity !== .75
      ) throw new Error("Empty ShapeWithText base style did not provide read-your-writes.");

      const emptyRevision = await runtime.commitAsync();
      const emptyFrame = await waitForFrameHash(
        (frame) => frame.revision === emptyRevision,
        "empty ShapeWithText base-style frame hash",
      );
      const confirmedEmpty = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id);
      const confirmedBaseStyle = confirmedEmpty?.textProperties?.baseStyle;
      if (
        confirmedEmpty?.text !== "" || confirmedEmpty.textProperties?.runs.length !== 0
        || confirmedBaseStyle?.fontSize !== 24
        || confirmedBaseStyle.letterSpacing !== 1.5
        || confirmedBaseStyle?.fillStack?.layers[0]?.paint?.css !== "#ff0000"
      ) throw new Error("Worker/Core did not persist the empty ShapeWithText base style.");
      append(`Empty ShapeWithText baseStyle passed the Worker/Core fence at revision ${emptyRevision}.`);

      text.insertCharacters(0, "Base", "AFTER");
      const insertedFills = text.getRangeFills(0, 4);
      const insertedCharacters = String(text.characters);
      if (
        insertedCharacters !== "Base" || text.getRangeFontSize(0, 4) !== 24
        || insertedFills === runtime.mixed || insertedFills[0]?.type !== "SOLID"
        || insertedFills[0].color.r !== 1 || insertedFills[0].opacity !== .75
      ) throw new Error("Insertion did not materialize the empty base style into a normal run.");
      const insertedRevision = await runtime.commitAsync();
      const insertedFrame = await waitForFrameHash(
        (frame) => frame.revision === insertedRevision,
        "materialized ShapeWithText frame hash",
      );
      const confirmedInserted = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id);
      const confirmedInsertedRun = confirmedInserted?.textProperties?.runs[0];
      if (
        confirmedInserted?.text !== "Base" || confirmedInserted.textProperties?.runs.length !== 1
        || confirmedInsertedRun?.start !== 0 || confirmedInsertedRun.end !== 4
        || confirmedInsertedRun.fontSize !== 24
        || confirmedInsertedRun?.fillStack?.layers[0]?.paint?.css !== "#ff0000"
      ) throw new Error("Worker/Core did not preserve the materialized base-style run.");
      if (insertedFrame.rgbaSha256 === emptyFrame.rgbaSha256) throw new Error("Materialized text did not change the real Worker Canvas frame.");
      const svg = await shape.exportAsync({ format: "SVG_STRING" });
      if (!svg.includes("Base") || !svg.includes('font-size="24"') || !svg.includes('letter-spacing="1.5"') || !svg.includes('fill="#ff0000"')) {
        throw new Error("Frozen SVG did not render the materialized base-style run.");
      }
      append(`Base-style insertion changed Canvas ${emptyFrame.rgbaSha256} → ${insertedFrame.rgbaSha256} and rendered in frozen SVG at revision ${insertedRevision}.`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > insertedRevision && snapshot.nodes.some((node) => node.id === shape.id && node.text === "" && node.textProperties?.baseStyle?.fontSize === 24),
        "empty base-style Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const undoFrame = await waitForFrameHash((frame) => frame.revision === undone.revision, "empty base-style Undo frame hash");
      if (undoFrame.rgbaSha256 !== emptyFrame.rgbaSha256) throw new Error("Undo did not restore the exact empty base-style Canvas frame.");

      const redoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > undone.revision && snapshot.nodes.some((node) => node.id === shape.id && node.text === "Base" && node.textProperties?.runs[0]?.fontSize === 24),
        "empty base-style Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const redone = await redoPromise;
      const redoFrame = await waitForFrameHash((frame) => frame.revision === redone.revision, "empty base-style Redo frame hash");
      if (redoFrame.rgbaSha256 !== insertedFrame.rgbaSha256) throw new Error("Redo did not restore the exact materialized Canvas frame.");
      append(`Empty baseStyle Undo/Redo restored exact Canvas hashes through revision ${redone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown empty base-style harness failure.");
    }
  };

  const runFontNameScript = async () => {
    const runtime = runtimeRef.current;
    const bridge = bridgeRef.current;
    const worker = workerRef.current;
    if (!runtime || !bridge || !worker) return;
    setState("running");
    setLines([]);
    try {
      const settledFrame = async (revision: number, description: string) => {
        // The confirmed document fence can precede a same-revision font/layout
        // resource redraw. Let that bounded projection settle, then resize away
        // and back to force a fresh full-frame evidence key at the target size.
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        await runtime.currentPage.setSelectionAsync([]);
        latestFrameHashRef.current = null;
        worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
        await waitForFrameHash((frame) => frame.revision === revision && frame.width === 901, `${description} resize preflight`);
        latestFrameHashRef.current = null;
        worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
        const frame = await waitForFrameHash((candidate) => candidate.revision === revision && candidate.width === 900, description);
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        return frame;
      };
      worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
      const fixtureFont = createPhase2ProfessionalCompositeFixture().assets.find((asset) => asset.mediaType === "font/ttf" && asset.bytesBase64);
      if (!fixtureFont?.bytesBase64) throw new Error("FontName fixture font is unavailable.");
      const fontBytes = Uint8Array.from(atob(fixtureFont.bytesBase64), (character) => character.charCodeAt(0));
      await bridge.registerAssetAsync(fixtureFont, fontBytes);
      const available = await runtime.listAvailableFontsAsync();
      const admitted = available.find((font) => font.assetId === fixtureFont.assetId);
      if (!admitted) throw new Error("Registered font did not enter the Runtime FontName catalog.");
      await runtime.loadFontAsync(admitted.fontName);
      append(`Loaded ${admitted.fontName.family} ${admitted.fontName.style} through the Worker FontFace fence.`);

      const text = runtime.createText();
      text.name = "FontName mixed text";
      text.x = 180;
      text.y = 170;
      text.characters = "Design";
      text.fontName = admitted.fontName;
      text.setRangeFontName(3, 6, { family: "Inter", style: "Regular" });
      const mixedFontName = text.getRangeFontName(0, 6);
      if (
        mixedFontName !== runtime.mixed
        || text.hasMissingFont
        || JSON.stringify(text.getRangeFontName(0, 3)) !== JSON.stringify(admitted.fontName)
        || text.getRangeAllFontNames(0, 6).length !== 2
      ) throw new Error("Text FontName mixed-range projection did not preserve both Canonical font identities.");

      const shape = runtime.createShapeWithText();
      shape.name = "FontName ShapeWithText";
      shape.x = 400;
      shape.y = 170;
      shape.resize(260, 120);
      shape.text.fontName = admitted.fontName;
      shape.text.fontSize = 32;
      shape.text.characters = "Design";
      if (shape.text.hasMissingFont || JSON.stringify(shape.text.fontName) !== JSON.stringify(admitted.fontName)) {
        throw new Error("ShapeWithText did not materialize its empty FontName base style.");
      }

      const confirmedRevision = await runtime.commitAsync();
      const confirmedFrame = await settledFrame(confirmedRevision, "FontName confirmed frame hash");
      const confirmedText = latestSnapshotRef.current?.nodes.find((node) => node.id === text.id);
      const confirmedShape = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id);
      const confirmedDocumentHash = latestSnapshotRef.current?.documentHash;
      if (
        confirmedText?.textProperties?.runs[0]?.font?.assetId !== fixtureFont.assetId
        || confirmedText.textProperties.runs[1]?.font != null
        || confirmedShape?.textProperties?.runs[0]?.font?.assetId !== fixtureFont.assetId
      ) throw new Error("Worker/Core did not preserve the FontName-to-FontReference mapping.");
      append(`FontName Text/ShapeWithText passed the Worker/Core and Canvas fence at revision ${confirmedRevision} (${confirmedFrame.rgbaSha256}).`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > confirmedRevision && !snapshot.nodes.some((node) => node.id === text.id || node.id === shape.id),
        "FontName creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const undoFrame = await waitForFrameHash((frame) => frame.revision === undone.revision, "FontName Undo frame hash");
      if (undoFrame.rgbaSha256 === confirmedFrame.rgbaSha256) throw new Error("FontName Undo did not remove the rendered nodes.");

      const redoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > undone.revision
          && snapshot.nodes.some((node) => node.id === text.id && node.textProperties?.runs[0]?.font?.assetId === fixtureFont.assetId)
          && snapshot.nodes.some((node) => node.id === shape.id && node.textProperties?.runs[0]?.font?.assetId === fixtureFont.assetId),
        "FontName creation Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const redone = await redoPromise;
      const redoFrame = await settledFrame(redone.revision, "FontName Redo frame hash");
      if (redoFrame.rgbaSha256 !== confirmedFrame.rgbaSha256) throw new Error(`FontName Redo did not restore the exact Canvas frame: ${confirmedFrame.rgbaSha256} → ${redoFrame.rgbaSha256}; document ${confirmedDocumentHash} → ${redone.documentHash}.`);
      append(`FontName Undo/Redo restored the exact Canvas frame through revision ${redone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown FontName harness failure.");
    }
  };

  const runTextCaseScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const baselineRevision = latestSnapshotRef.current?.revision ?? 0;
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 899, height: 600, dpr: 1 } satisfies MainToWorker);
      await waitForFrameHash((frame) => frame.revision === baselineRevision && frame.width === 899, "TextCase baseline preflight");
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
      const baselineFrame = await waitForFrameHash((frame) => frame.revision === baselineRevision && frame.width === 900, "TextCase baseline frame");
      append(`TextCase baseline frame at revision ${baselineRevision}: ${baselineFrame.rgbaSha256}.`);
      const text = runtime.createText();
      text.name = "TextCase mixed text";
      text.x = -300;
      text.y = -120;
      text.resize(330, 80);
      text.fills = [{ type: "SOLID", color: { r: 31 / 255, g: 41 / 255, b: 55 / 255 } }];
      text.characters = "straße title CAPS";

      const shape = runtime.createShapeWithText();
      shape.name = "TextCase ShapeWithText";
      shape.x = 80;
      shape.y = -140;
      shape.resize(260, 120);
      shape.text.fontSize = 30;
      shape.text.characters = "Shape Case";

      const originalRevision = await runtime.commitAsync();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await runtime.currentPage.setSelectionAsync([]);
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
      await waitForFrameHash((frame) => frame.revision === originalRevision && frame.width === 901, "TextCase original frame preflight");
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
      const originalFrame = await waitForFrameHash((frame) => frame.revision === originalRevision && frame.width === 900, "TextCase original frame");
      append(`TextCase original-case frame at revision ${originalRevision}: ${originalFrame.rgbaSha256}; viewport=${JSON.stringify(latestSnapshotRef.current?.viewport)}.`);

      text.setRangeTextCase(0, 6, "UPPER");
      text.setRangeTextCase(7, 12, "TITLE");
      text.setRangeTextCase(13, 17, "SMALL_CAPS_FORCED");
      shape.text.textCase = "SMALL_CAPS";
      if (
        text.textCase !== runtime.mixed
        || text.getRangeTextCase(0, 6) !== "UPPER"
        || text.getRangeTextCase(7, 12) !== "TITLE"
        || text.getRangeTextCase(13, 17) !== "SMALL_CAPS_FORCED"
        || shape.text.textCase !== "SMALL_CAPS"
      ) throw new Error("TextCase range projection did not preserve all requested values.");

      const confirmedRevision = await runtime.commitAsync();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
      await waitForFrameHash((frame) => frame.revision === confirmedRevision && frame.width === 901, "TextCase case frame preflight");
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
      const confirmedFrame = await waitForFrameHash((frame) => frame.revision === confirmedRevision && frame.width === 900, "TextCase confirmed frame");
      if (confirmedFrame.rgbaSha256 === originalFrame.rgbaSha256) throw new Error("TextCase edits did not change the real Worker Canvas frame.");
      const confirmedText = latestSnapshotRef.current?.nodes.find((node) => node.id === text.id);
      const confirmedShape = latestSnapshotRef.current?.nodes.find((node) => node.id === shape.id);
      const cases = confirmedText?.textProperties?.runs.map((run) => run.textCase);
      if (
        confirmedText?.text !== "straße title CAPS"
        || !cases?.includes("upper")
        || !cases.includes("title")
        || !cases.includes("smallCapsForced")
        || confirmedShape?.text !== "Shape Case"
        || confirmedShape.textProperties?.runs[0]?.textCase !== "smallCaps"
      ) throw new Error("Worker/Core did not preserve Canonical source text and TextCase runs.");
      const svg = await text.exportAsync({ format: "SVG_STRING" });
      const shapeSvg = await shape.exportAsync({ format: "SVG_STRING" });
      if (
        !svg.includes("STRASSE")
        || !svg.includes("Title")
        || !svg.includes(">CAPS</tspan>")
        || !svg.includes('font-variant-caps="all-small-caps"')
        || !shapeSvg.includes("Shape Case")
        || !shapeSvg.includes('font-variant-caps="small-caps"')
      ) throw new Error("Frozen SVG did not preserve the TextCase presentation contract.");
      append(`TextCase source/ranges, Canvas and SVG passed at revision ${confirmedRevision} (${confirmedFrame.rgbaSha256}).`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > confirmedRevision
          && snapshot.nodes.some((node) => node.id === text.id)
          && snapshot.nodes.some((node) => node.id === shape.id),
        "TextCase edit Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const undoneText = undone.nodes.find((node) => node.id === text.id);
      const undoneShape = undone.nodes.find((node) => node.id === shape.id);
      if (
        undoneText?.textProperties?.runs.some((run) => run.textCase !== undefined)
        || undoneShape?.textProperties?.runs.some((run) => run.textCase !== undefined)
      ) throw new Error(`TextCase Undo retained a case run: ${JSON.stringify({ text: undoneText?.textProperties?.runs, shape: undoneShape?.textProperties?.runs })}.`);
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
      await waitForFrameHash((frame) => frame.revision === undone.revision && frame.width === 901, "TextCase Undo preflight");
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
      const undoFrame = await waitForFrameHash((frame) => frame.revision === undone.revision && frame.width === 900, "TextCase Undo frame");
      if (undoFrame.rgbaSha256 !== originalFrame.rgbaSha256) throw new Error("TextCase Undo did not restore the exact original-case frame.");

      const redoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > undone.revision
          && snapshot.nodes.some((node) => node.id === text.id && node.textProperties?.runs.some((run) => run.textCase === "smallCapsForced"))
          && snapshot.nodes.some((node) => node.id === shape.id && node.textProperties?.runs[0]?.textCase === "smallCaps"),
        "TextCase creation Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const redone = await redoPromise;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
      await waitForFrameHash((frame) => frame.revision === redone.revision && frame.width === 901, "TextCase Redo preflight");
      latestFrameHashRef.current = null;
      worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
      const redoFrame = await waitForFrameHash((frame) => frame.revision === redone.revision && frame.width === 900, "TextCase Redo frame");
      if (redoFrame.rgbaSha256 !== confirmedFrame.rgbaSha256) {
        throw new Error(`TextCase Redo did not restore the exact Canvas frame: ${confirmedFrame.rgbaSha256} → ${redoFrame.rgbaSha256}.`);
      }
      append(`TextCase Undo/Redo restored the exact Canvas frame through revision ${redone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown TextCase harness failure.");
    }
  };

  const runTextCaseShapingScript = async () => {
    const runtime = runtimeRef.current;
    const bridge = bridgeRef.current;
    const worker = workerRef.current;
    if (!runtime || !bridge || !worker) return;
    setState("running");
    setLines([]);
    try {
      const settledFrame = async (targetRevision: number, description: string) => {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        await runtime.currentPage.setSelectionAsync([]);
        latestFrameHashRef.current = null;
        worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
        await waitForFrameHash((frame) => frame.revision === targetRevision && frame.width === 901, `${description} preflight`);
        latestFrameHashRef.current = null;
        worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
        return waitForFrameHash((frame) => frame.revision === targetRevision && frame.width === 900, description);
      };
      const requestCaretLayout = (nodeId: string, text: string) => new Promise<Extract<WorkerToMain, { type: "text-caret-layout" }>>((resolve, reject) => {
        const requestId = `w12-text-case-shaping:${crypto.randomUUID()}`;
        const timeoutId = window.setTimeout(() => {
          worker.removeEventListener("message", onMessage);
          reject(new Error("Timed out waiting for the TextCase Rust caret layout."));
        }, 10_000);
        const onMessage = ({ data }: MessageEvent<WorkerToMain>) => {
          if (data.type !== "text-caret-layout" || data.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          worker.removeEventListener("message", onMessage);
          resolve(data);
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({ type: "text-caret-layout", requestId, nodeId, text } satisfies MainToWorker);
      });

      const fixtureFont = createPhase2ProfessionalCompositeFixture().assets.find((asset) => asset.mediaType === "font/ttf" && asset.bytesBase64);
      if (!fixtureFont?.bytesBase64) throw new Error("TextCase shaping fixture font is unavailable.");
      const fontBytes = Uint8Array.from(atob(fixtureFont.bytesBase64), (character) => character.charCodeAt(0));
      await bridge.registerAssetAsync(fixtureFont, fontBytes);
      const admitted = (await runtime.listAvailableFontsAsync()).find((font) => font.assetId === fixtureFont.assetId);
      if (!admitted) throw new Error("TextCase shaping font did not enter the Runtime catalog.");
      await runtime.loadFontAsync(admitted.fontName);

      const text = runtime.createText();
      text.name = "TextCase Rust shaping";
      text.x = -180;
      text.y = -60;
      text.resize(360, 90);
      text.fills = [{ type: "SOLID", color: { r: 31 / 255, g: 41 / 255, b: 55 / 255 } }];
      text.fontName = admitted.fontName;
      text.characters = "design";
      text.setRangeFontSize(0, 6, 42);
      text.textCase = "TITLE";
      const confirmedRevision = await runtime.commitAsync();
      const confirmedFrame = await settledFrame(confirmedRevision, "TextCase shaped frame");
      const caret = await requestCaretLayout(text.id, "design");
      const expectedCarets = [0, 1, 2, 3, 4, 5, 6];
      if (
        !caret.layout?.unitsPerEm
        || JSON.stringify(caret.layout.carets.map((item) => item.byteOffset)) !== JSON.stringify(expectedCarets)
        || caret.layout.lines?.[0]?.start !== 0 || caret.layout.lines[0].end !== 6
        || caret.layout.lines[0].visualCarets?.[0]?.xAdvance !== 0
        || (caret.layout.lines[0].visualCarets?.at(-1)?.xAdvance ?? 0) <= 0
      ) throw new Error(`TextCase did not return a source-addressed Rust caret layout: ${JSON.stringify(caret.layout)}.`);
      const confirmed = latestSnapshotRef.current?.nodes.find((node) => node.id === text.id);
      if (confirmed?.text !== "design" || confirmed.textProperties?.runs[0]?.textCase !== "title") {
        throw new Error("TextCase shaping changed the Canonical source or lost its style.");
      }
      const svg = await text.exportAsync({ format: "SVG_STRING" });
      if (!svg.includes("Design") || svg.includes(">design</tspan>")) throw new Error("TextCase shaped SVG did not use presentation text.");
      append(`Rust TextCase shaping returned ${caret.layout.unitsPerEm} units/em with source carets ${expectedCarets.join(",")} at revision ${confirmedRevision} (${confirmedFrame.rgbaSha256}).`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > confirmedRevision && !snapshot.nodes.some((node) => node.id === text.id),
        "TextCase shaping Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const undoFrame = await settledFrame(undone.revision, "TextCase shaping Undo frame");
      if (undoFrame.rgbaSha256 === confirmedFrame.rgbaSha256) throw new Error("TextCase shaping Undo retained the rendered text.");

      const redoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > undone.revision
          && snapshot.nodes.some((node) => node.id === text.id && node.text === "design" && node.textProperties?.runs[0]?.textCase === "title"),
        "TextCase shaping Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const redone = await redoPromise;
      const redoFrame = await settledFrame(redone.revision, "TextCase shaping Redo frame");
      const redoCaret = await requestCaretLayout(text.id, "design");
      if (redoFrame.rgbaSha256 !== confirmedFrame.rgbaSha256 || !redoCaret.layout?.unitsPerEm) {
        throw new Error(`TextCase shaping Redo did not restore the exact derived frame/layout: ${confirmedFrame.rgbaSha256} → ${redoFrame.rgbaSha256}.`);
      }
      append(`TextCase shaping Undo/Redo restored the exact Canvas frame and Rust caret layout through revision ${redone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown TextCase shaping harness failure.");
    }
  };

  const runPerRunShapingScript = async () => {
    const runtime = runtimeRef.current;
    const bridge = bridgeRef.current;
    const worker = workerRef.current;
    if (!runtime || !bridge || !worker) return;
    setState("running");
    setLines([]);
    try {
      const settledFrame = async (targetRevision: number, description: string) => {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        await runtime.currentPage.setSelectionAsync([]);
        latestFrameHashRef.current = null;
        worker.postMessage({ type: "resize", width: 901, height: 600, dpr: 1 } satisfies MainToWorker);
        await waitForFrameHash((frame) => frame.revision === targetRevision && frame.width === 901, `${description} preflight`);
        latestFrameHashRef.current = null;
        worker.postMessage({ type: "resize", width: 900, height: 600, dpr: 1 } satisfies MainToWorker);
        return waitForFrameHash((frame) => frame.revision === targetRevision && frame.width === 900, description);
      };
      const requestCaretLayout = (nodeId: string, text: string) => new Promise<Extract<WorkerToMain, { type: "text-caret-layout" }>>((resolve, reject) => {
        const requestId = `w12-per-run-shaping:${crypto.randomUUID()}`;
        const timeoutId = window.setTimeout(() => {
          worker.removeEventListener("message", onMessage);
          reject(new Error("Timed out waiting for the per-run Rust caret layout."));
        }, 10_000);
        const onMessage = ({ data }: MessageEvent<WorkerToMain>) => {
          if (data.type !== "text-caret-layout" || data.requestId !== requestId) return;
          window.clearTimeout(timeoutId);
          worker.removeEventListener("message", onMessage);
          resolve(data);
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({ type: "text-caret-layout", requestId, nodeId, text } satisfies MainToWorker);
      });

      const fixtureFont = createPhase2ProfessionalCompositeFixture().assets.find((asset) => asset.mediaType === "font/ttf" && asset.bytesBase64);
      if (!fixtureFont?.bytesBase64) throw new Error("Per-run shaping fixture font is unavailable.");
      const fontBytes = Uint8Array.from(atob(fixtureFont.bytesBase64), (character) => character.charCodeAt(0));
      await bridge.registerAssetAsync(fixtureFont, fontBytes);
      const admitted = (await runtime.listAvailableFontsAsync()).find((font) => font.assetId === fixtureFont.assetId);
      if (!admitted) throw new Error("Per-run shaping font did not enter the Runtime catalog.");
      await runtime.loadFontAsync(admitted.fontName);

      const source = "Design\nDesign";
      const text = runtime.createText();
      text.name = "Rust per-run shaping";
      text.x = -100;
      text.y = -80;
      text.resize(58, 130);
      text.fills = [{ type: "SOLID", color: { r: 31 / 255, g: 41 / 255, b: 55 / 255 } }];
      text.fontName = admitted.fontName;
      text.characters = source;
      text.setRangeFontSize(0, 7, 16);
      text.setRangeFontSize(7, source.length, 32);
      text.setRangeLetterSpacing(0, 7, { value: 2, unit: "PIXELS" });
      text.setRangeLetterSpacing(7, source.length, { value: -0.25, unit: "PIXELS" });
      const confirmedRevision = await runtime.commitAsync();
      const confirmedFrame = await settledFrame(confirmedRevision, "per-run shaped frame");
      const caret = await requestCaretLayout(text.id, source);
      const confirmed = latestSnapshotRef.current?.nodes.find((node) => node.id === text.id);
      if (
        !caret.layout?.unitsPerEm
        || caret.layout.lines?.length !== 2
        || caret.layout.lines[0]?.start !== 0 || caret.layout.lines[0].end !== 6
        || caret.layout.lines[1]?.start !== 7 || caret.layout.lines[1].end !== source.length
        || (caret.layout.lines[1].advance ?? 0) <= (caret.layout.lines[0].advance ?? 0)
        || caret.layout.lines.some((line) => !line.visualCarets?.length
          || line.visualCarets[0]?.xAdvance !== 0
          || line.visualCarets.at(-1)?.xAdvance !== line.advance
          || line.visualCarets.some((stop, index, stops) => index > 0 && stop.xAdvance < stops[index - 1]!.xAdvance))
      ) throw new Error(`Per-run font sizes did not return one source-addressed Rust layout: ${JSON.stringify({ layout: caret.layout, runs: confirmed?.textProperties?.runs, diagnostics: latestSnapshotRef.current?.diagnostics })}.`);
      if (
        confirmed?.text !== source
        || confirmed.textProperties?.runs.length !== 2
        || confirmed.textProperties.runs[0]?.fontSize !== 16
        || confirmed.textProperties.runs[1]?.fontSize !== 32
        || confirmed.textProperties.runs[0]?.letterSpacing !== 2
        || confirmed.textProperties.runs[1]?.letterSpacing !== -0.25
      ) throw new Error("Per-run shaping changed the Canonical text or style ranges.");
      const svg = await text.exportAsync({ format: "SVG_STRING" });
      if ((svg.match(/Design/gu)?.length ?? 0) < 2
        || !svg.includes('font-size="16"') || !svg.includes('font-size="32"')
        || !svg.includes('letter-spacing="2"') || !svg.includes('letter-spacing="-0.25"')) {
        throw new Error("Per-run shaped SVG did not preserve both frozen line ranges, font sizes and tracking values.");
      }
      append(`Rust per-run shaping returned two source lines with 2/-0.25px tracking and ${caret.layout.unitsPerEm} units/em at revision ${confirmedRevision} (${confirmedFrame.rgbaSha256}).`);

      const undoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > confirmedRevision && !snapshot.nodes.some((node) => node.id === text.id),
        "per-run shaping Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const undoFrame = await settledFrame(undone.revision, "per-run shaping Undo frame");
      if (undoFrame.rgbaSha256 === confirmedFrame.rgbaSha256) throw new Error("Per-run shaping Undo retained the rendered text.");

      const redoPromise = waitForSnapshot(
        (snapshot) => snapshot.revision > undone.revision
          && snapshot.nodes.some((node) => node.id === text.id && node.textProperties?.runs.length === 2),
        "per-run shaping Redo projection",
      );
      worker.postMessage({ type: "command", command: { type: "redo" } } satisfies MainToWorker);
      const redone = await redoPromise;
      const redoFrame = await settledFrame(redone.revision, "per-run shaping Redo frame");
      const redoCaret = await requestCaretLayout(text.id, source);
      if (redoFrame.rgbaSha256 !== confirmedFrame.rgbaSha256 || redoCaret.layout?.lines?.length !== 2) {
        throw new Error(`Per-run shaping Redo did not restore the exact frame/layout: ${confirmedFrame.rgbaSha256} → ${redoFrame.rgbaSha256}.`);
      }
      append(`Per-run font-size/tracking Undo/Redo restored the exact Canvas frame and two-line Rust layout through revision ${redone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown per-run shaping harness failure.");
    }
  };

  const runPaintStackScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const bytes = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9M5W8AAAAASUVORK5CYII="),
        (character) => character.charCodeAt(0),
      );
      const image = await runtime.createImageAsync(bytes, "image/png", { timeoutMs: 10_000 });
      const rectangle = runtime.createRectangle();
      rectangle.name = "Runtime Paint Stack";
      rectangle.x = 80;
      rectangle.y = 80;
      rectangle.resize(320, 220);
      rectangle.fills = [
        { type: "SOLID", color: { r: 1, g: .1, b: .1 }, opacity: .5, blendMode: "MULTIPLY" },
        {
          type: "GRADIENT_LINEAR",
          gradientTransform: [[1, 0, 0], [0, 1, 0]],
          gradientStops: [
            { position: 0, color: { r: 0, g: .4, b: 1, a: 1 } },
            { position: 1, color: { r: .2, g: 1, b: .5, a: .4 } },
          ],
          opacity: .75,
          blendMode: "SCREEN",
        },
      ];
      rectangle.strokes = [];
      if (
        rectangle.fills.length !== 2
        || rectangle.fills[0]?.type !== "SOLID"
        || rectangle.fills[0].blendMode !== "MULTIPLY"
        || rectangle.fills[1]?.type !== "GRADIENT_LINEAR"
        || rectangle.strokes.length !== 0
      ) throw new Error("PendingProjection did not preserve the Figma-shaped Paint Stack.");
      append("Pending Solid/Linear Paint Stack and explicit empty strokes passed before Ack.");

      const createdRevision = await runtime.commitAsync();
      const confirmed = latestSnapshotRef.current?.nodes.find((node) => node.id === rectangle.id);
      if (confirmed?.fillStack?.layers.length !== 2 || confirmed.strokeStack?.layers.length !== 0) {
        throw new Error("Worker/Core did not preserve Paint Stack presence and layer order.");
      }
      const svg = await rectangle.exportAsync({ format: "SVG_STRING" });
      if (
        !svg.includes("<linearGradient")
        || !svg.includes('opacity="0.5"')
        || !svg.includes("mix-blend-mode:multiply")
        || !svg.includes('opacity="0.75"')
        || !svg.includes("mix-blend-mode:screen")
      ) throw new Error("Frozen SVG did not preserve per-layer gradient, opacity, blend, and order.");
      append(`Confirmed Paint Stack and frozen SVG passed at revision ${createdRevision}.`);

      rectangle.fills = [
        ...rectangle.fills,
        { type: "IMAGE", imageHash: image.hash, scaleMode: "TILE", scalingFactor: .5, opacity: .6, filters: { exposure: .25, tint: -.5, shadows: .2 } },
      ];
      let missingRejected = false;
      try {
        rectangle.fills = [{ type: "IMAGE", imageHash: "missing-image", scaleMode: "CROP" }];
      } catch (error) {
        missingRejected = isRuntimeError(error, "RESOURCE_UNAVAILABLE");
      }
      if (!missingRejected || rectangle.fills.length !== 3 || rectangle.fills[2]?.type !== "IMAGE") {
        throw new Error("Image Paint validation changed the previously staged valid stack.");
      }
      append("Pending Tile Image Paint passed and an unknown image hash was rejected without mutation.");
      const imageRevision = await runtime.commitAsync();
      const confirmedImage = latestSnapshotRef.current?.nodes.find((node) => node.id === rectangle.id)?.fillStack?.layers[2]?.image;
      if (
        confirmedImage?.assetId !== image.hash
        || confirmedImage.scaleMode !== "tile"
        || confirmedImage.transform.a !== .5
        || confirmedImage.transform.d !== .5
        || confirmedImage.filters?.exposure !== .25
        || confirmedImage.filters?.tint !== -.5
        || confirmedImage.filters?.shadows !== .2
        || rectangle.fills[2]?.type !== "IMAGE"
        || rectangle.fills[2].scalingFactor !== .5
        || rectangle.fills[2].filters?.exposure !== .25
        || rectangle.fills[2].filters?.tint !== -.5
        || rectangle.fills[2].filters?.shadows !== .2
        || rectangle.fills[2].imageTransform !== undefined
      ) throw new Error("Worker/Core did not preserve the Runtime Tile Image Paint transform.");
      append(`Confirmed Image Paint fence passed at revision ${imageRevision}.`);

      const editUndoPromise = waitForSnapshot(
        (next) => next.revision > imageRevision && next.nodes.find((node) => node.id === rectangle.id)?.fillStack?.layers.length === 2,
        "Paint Stack edit Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const editUndone = await editUndoPromise;
      if ([...rectangle.fills].length !== 2) throw new Error("Undo did not restore the two-layer Paint Stack.");
      append(`Paint Stack edit Undo passed at revision ${editUndone.revision}.`);

      const createUndoPromise = waitForSnapshot(
        (next) => next.revision > editUndone.revision && !next.nodes.some((node) => node.id === rectangle.id),
        "Paint Stack creation Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const createUndone = await createUndoPromise;
      if (!rectangle.removed) throw new Error("Undo did not retire the Paint Stack node proxy.");
      append(`Paint Stack creation Undo retired the proxy at revision ${createUndone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown Paint Stack harness failure.");
    }
  };

  const runRefreshHashScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const frame = runtime.createFrame();
      frame.name = "M1 refresh hash card";
      frame.x = 96;
      frame.y = 112;
      frame.resize(240, 120);
      const revision = await runtime.commitAsync();
      const committedSnapshot = latestSnapshotRef.current;
      if (
        !committedSnapshot?.localSnapshot ||
        !committedSnapshot.documentHash
      ) {
        throw new Error(
          "Committed snapshot did not include a Canonical local snapshot and hash.",
        );
      }
      const committedHash = committedSnapshot.documentHash;
      append(
        `Committed Canonical snapshot at revision ${revision}: ${committedHash}.`,
      );

      const requestId = `m1-refresh-hash:${crypto.randomUUID()}`;
      const hydratedSnapshotPromise = waitForSnapshot(
        (snapshot) =>
          snapshot.hydrationRequestId === requestId &&
          snapshot.documentCore === "Rust/WASM bridge ready",
        "Canonical refresh hydration",
      );
      worker.postMessage({
        type: "command",
        command: {
          type: "hydrate",
          snapshot: committedSnapshot.localSnapshot,
          requestId,
        },
      } satisfies MainToWorker);
      const hydratedSnapshot = await hydratedSnapshotPromise;
      const hydratedFrame = await runtime.getNodeByIdAsync(frame.id);
      if (
        hydratedSnapshot.documentHash !== committedHash ||
        !hydratedFrame ||
        hydratedFrame.name !== frame.name ||
        hydratedFrame.x !== 96
      ) {
        throw new Error(
          "Canonical refresh changed the document hash or failed to restore the card.",
        );
      }
      append(`Refresh hash fence passed: ${hydratedSnapshot.documentHash}.`);
      append(
        `Hydrated card restored at revision ${hydratedSnapshot.revision}.`,
      );
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runAutoLayoutScript = async () => {
    const runtime = runtimeRef.current;
    const worker = workerRef.current;
    if (!runtime || !worker) return;
    setState("running");
    setLines([]);
    try {
      const wrapFrame = runtime.createFrame();
      wrapFrame.name = "W12 horizontal wrap baseline";
      wrapFrame.x = 40;
      wrapFrame.y = 60;
      wrapFrame.resize(240, 180);
      wrapFrame.layoutMode = "HORIZONTAL";
      wrapFrame.paddingTop = 10;
      wrapFrame.paddingRight = 10;
      wrapFrame.paddingBottom = 10;
      wrapFrame.paddingLeft = 10;
      wrapFrame.itemSpacing = 10;
      wrapFrame.primaryAxisSizingMode = "FIXED";
      wrapFrame.counterAxisSizingMode = "FIXED";
      wrapFrame.layoutWrap = "WRAP";
      wrapFrame.counterAxisAlignItems = "BASELINE";
      wrapFrame.counterAxisSpacing = 18;
      wrapFrame.counterAxisAlignContent = "SPACE_BETWEEN";
      const wrapChildren = [30, 50, 40].map((height, index) => {
        const child = runtime.createRectangle();
        child.name = `Wrap item ${index + 1}`;
        child.x = 999;
        child.y = 999;
        child.resize(100, height);
        wrapFrame.appendChild(child);
        return child;
      });

      const flexibleWrapFrame = runtime.createFrame();
      flexibleWrapFrame.name = "W12 flexible counter-hug wrap";
      flexibleWrapFrame.x = 40;
      flexibleWrapFrame.y = 520;
      flexibleWrapFrame.resize(120, 1);
      flexibleWrapFrame.layoutMode = "HORIZONTAL";
      flexibleWrapFrame.paddingTop = 5;
      flexibleWrapFrame.paddingRight = 5;
      flexibleWrapFrame.paddingBottom = 5;
      flexibleWrapFrame.paddingLeft = 5;
      flexibleWrapFrame.itemSpacing = 10;
      flexibleWrapFrame.layoutWrap = "WRAP";
      flexibleWrapFrame.counterAxisSpacing = 7;
      flexibleWrapFrame.counterAxisSizingMode = "AUTO";
      const flexibleWrapFirst = runtime.createRectangle();
      flexibleWrapFirst.name = "Flexible wrap fixed peer";
      flexibleWrapFirst.resize(50, 20);
      flexibleWrapFrame.appendChild(flexibleWrapFirst);
      const flexibleWrapFill = runtime.createRectangle();
      flexibleWrapFill.name = "Flexible wrap fill";
      flexibleWrapFill.resize(240, 10);
      flexibleWrapFrame.appendChild(flexibleWrapFill);
      flexibleWrapFill.minWidth = 20;
      flexibleWrapFill.maxWidth = 40;
      flexibleWrapFill.layoutSizingHorizontal = "FILL";
      const flexibleWrapThird = runtime.createRectangle();
      flexibleWrapThird.name = "Flexible wrap second track";
      flexibleWrapThird.resize(80, 10);
      flexibleWrapFrame.appendChild(flexibleWrapThird);

      const flowFrame = runtime.createFrame();
      flowFrame.name = "W12 fill nested absolute";
      flowFrame.x = 340;
      flowFrame.y = 60;
      flowFrame.resize(400, 200);
      flowFrame.layoutMode = "HORIZONTAL";
      flowFrame.paddingTop = 20;
      flowFrame.paddingRight = 20;
      flowFrame.paddingBottom = 20;
      flowFrame.paddingLeft = 20;
      flowFrame.itemSpacing = 12;
      flowFrame.counterAxisAlignItems = "BASELINE";

      const nested = runtime.createFrame();
      nested.name = "Nested hug frame";
      nested.resize(100, 80);
      nested.layoutMode = "VERTICAL";
      nested.paddingTop = 10;
      nested.paddingRight = 10;
      nested.paddingBottom = 10;
      nested.paddingLeft = 10;
      nested.primaryAxisSizingMode = "AUTO";
      const nestedChild = runtime.createRectangle();
      nestedChild.name = "Nested child";
      nestedChild.resize(80, 30);
      nested.appendChild(nestedChild);
      flowFrame.appendChild(nested);
      nested.layoutAlign = "MIN";

      const fill = runtime.createRectangle();
      fill.name = "Bounded fill child";
      fill.resize(50, 40);
      flowFrame.appendChild(fill);
      fill.layoutSizingHorizontal = "FILL";
      fill.minWidth = 120;
      fill.maxWidth = 180;

      const absolute = runtime.createRectangle();
      absolute.name = "Absolute child";
      absolute.x = 700;
      absolute.y = 90;
      absolute.resize(24, 24);
      flowFrame.appendChild(absolute);
      absolute.layoutPositioning = "ABSOLUTE";

      const textFrame = runtime.createFrame();
      textFrame.name = "W12 text hug frame";
      textFrame.x = 340;
      textFrame.y = 300;
      textFrame.resize(160, 10);
      textFrame.layoutMode = "VERTICAL";
      textFrame.paddingTop = 10;
      textFrame.paddingRight = 10;
      textFrame.paddingBottom = 10;
      textFrame.paddingLeft = 10;
      textFrame.primaryAxisSizingMode = "AUTO";
      const autoText = runtime.createText();
      autoText.name = "Auto-sized text";
      autoText.resize(140, 1);
      autoText.characters = "Alpha\nBeta";
      autoText.textAutoResize = "HEIGHT";
      textFrame.appendChild(autoText);

      const constraintFrame = runtime.createFrame();
      constraintFrame.name = "W12 constraint resize frame";
      constraintFrame.x = 40;
      constraintFrame.y = 300;
      constraintFrame.resize(200, 100);
      const constrained = runtime.createRectangle();
      constrained.name = "Stretch and center child";
      constrained.x = 60;
      constrained.y = 320;
      constrained.resize(100, 30);
      constraintFrame.appendChild(constrained);
      constrained.constraints = { horizontal: "STRETCH", vertical: "CENTER" };
      if (
        wrapFrame.layoutWrap !== "WRAP" ||
        wrapFrame.counterAxisAlignItems !== "BASELINE" ||
        wrapFrame.counterAxisSpacing !== 18 ||
        wrapFrame.counterAxisAlignContent !== "SPACE_BETWEEN" ||
        nested.layoutSizingVertical !== "HUG" ||
        nested.layoutAlign !== "MIN" ||
        fill.layoutSizingHorizontal !== "FILL" ||
        fill.layoutAlign !== "INHERIT" ||
        fill.minWidth !== 120 ||
        fill.maxWidth !== 180 ||
        absolute.layoutPositioning !== "ABSOLUTE" ||
        autoText.textAutoResize !== "HEIGHT" ||
        textFrame.primaryAxisSizingMode !== "AUTO" ||
        constrained.constraints.horizontal !== "STRETCH" ||
        constrained.constraints.vertical !== "CENTER" ||
        flexibleWrapFrame.counterAxisSizingMode !== "AUTO" ||
        flexibleWrapFill.layoutSizingHorizontal !== "FILL" ||
        nestedChild.parent !== nested
      ) {
        throw new Error(
          "PendingProjection did not preserve the W12-L Auto Layout declarations.",
        );
      }
      append(
        "Pending wrap tracks, baseline, child alignment, hug/fill, bounds, nested, absolute-child and constraints assertions passed.",
      );
      const revision = await runtime.commitAsync();
      const [first, second, third, committedNested, committedFill, committedAbsolute, committedTextFrame, committedAutoText, committedFlexibleWrap, committedFlexibleFirst, committedFlexibleFill, committedFlexibleThird] = await Promise.all([
        ...wrapChildren.map((node) => runtime.getNodeByIdAsync(node.id)),
        runtime.getNodeByIdAsync(nested.id),
        runtime.getNodeByIdAsync(fill.id),
        runtime.getNodeByIdAsync(absolute.id),
        runtime.getNodeByIdAsync(textFrame.id),
        runtime.getNodeByIdAsync(autoText.id),
        runtime.getNodeByIdAsync(flexibleWrapFrame.id),
        runtime.getNodeByIdAsync(flexibleWrapFirst.id),
        runtime.getNodeByIdAsync(flexibleWrapFill.id),
        runtime.getNodeByIdAsync(flexibleWrapThird.id),
      ]);
      if (
        !first || !second || !third || !committedNested || !committedFill || !committedAbsolute || !committedTextFrame || !committedAutoText || !committedFlexibleWrap || !committedFlexibleFirst || !committedFlexibleFill || !committedFlexibleThird ||
        first.x !== 50 || first.y !== 90 ||
        second.x !== 160 || second.y !== 70 ||
        third.x !== 50 || third.y !== 190 ||
        committedNested.x !== 360 || committedNested.y !== 80 || committedNested.height !== 50 ||
        committedFill.x !== 472 || committedFill.y !== 80 || committedFill.width !== 180 || committedFill.height !== 40 ||
        committedAbsolute.x !== 700 || committedAbsolute.y !== 90 ||
        committedTextFrame.height !== 60 || committedAutoText.height !== 40 || committedAutoText.textAutoResize !== "HEIGHT" ||
        committedFlexibleWrap.height !== 47 ||
        committedFlexibleFirst.x !== 45 || committedFlexibleFirst.y !== 525 || committedFlexibleFirst.width !== 50 || committedFlexibleFirst.height !== 20 ||
        committedFlexibleFill.x !== 105 || committedFlexibleFill.y !== 525 || committedFlexibleFill.width !== 40 || committedFlexibleFill.height !== 10 ||
        committedFlexibleThird.x !== 45 || committedFlexibleThird.y !== 552 || committedFlexibleThird.width !== 80 || committedFlexibleThird.height !== 10
      ) {
        append(`Auto Layout actual: wrap=${[first, second, third].map((node) => node ? `${node.x},${node.y}` : "missing").join(";")} nested=${committedNested ? `${committedNested.x},${committedNested.y},${committedNested.height}` : "missing"} fill=${committedFill ? `${committedFill.x},${committedFill.y},${committedFill.width}` : "missing"} flexible=${committedFlexibleWrap && committedFlexibleFirst && committedFlexibleFill && committedFlexibleThird ? `${committedFlexibleWrap.height}/${committedFlexibleFirst.x},${committedFlexibleFirst.y}/${committedFlexibleFill.x},${committedFlexibleFill.y},${committedFlexibleFill.width}/${committedFlexibleThird.x},${committedFlexibleThird.y}` : "missing"} absolute=${committedAbsolute ? `${committedAbsolute.x},${committedAbsolute.y}` : "missing"} text=${committedTextFrame && committedAutoText ? `${committedTextFrame.height}/${committedAutoText.height}/${committedAutoText.textAutoResize}` : "missing"}.`);
        throw new Error(
          "Canonical Auto Layout reflow did not preserve wrap, baseline, bounded fill, nested hug and absolute positioning.",
        );
      }
      append(
        `Canonical fixed/flexible wrap-track distribution, counter-axis HUG, baseline, child alignment, nested hug/fill and Text HEIGHT auto-resize reflow passed at revision ${revision}.`,
      );
      const [wrapSvg, flowSvg, textSvg, flexibleWrapSvg] = await Promise.all([
        wrapFrame.exportAsync({ format: "SVG_STRING" }),
        flowFrame.exportAsync({ format: "SVG_STRING" }),
        textFrame.exportAsync({ format: "SVG_STRING" }),
        flexibleWrapFrame.exportAsync({ format: "SVG_STRING" }),
      ]);
      if ((wrapSvg.match(/<path\b/g)?.length ?? 0) < 4 || (flowSvg.match(/<path\b/g)?.length ?? 0) < 5 || (flexibleWrapSvg.match(/<path\b/g)?.length ?? 0) < 4 || !textSvg.includes("Alpha") || !textSvg.includes("Beta")) {
        throw new Error("Confirmed Auto Layout Frames did not export their laid-out child geometry.");
      }
      append("Confirmed wrap and nested flow Frames exported through frozen SVG scenes.");

      fill.minHeight = 40;
      fill.maxHeight = 40;
      fill.layoutAlign = "STRETCH";
      wrapFrame.appendChild(fill);
      constraintFrame.resize(300, 200);
      autoText.characters = "Alpha\nBeta\nGamma";
      if (fill.parent !== wrapFrame || fill.layoutSizingHorizontal !== "FILL" || fill.layoutAlign !== "STRETCH") {
        throw new Error("Pending reparent did not update the child and sizing mode atomically.");
      }
      const reparentRevision = await runtime.commitAsync();
      const committedConstrained = await runtime.getNodeByIdAsync(constrained.id);
      const resizedTextFrame = await runtime.getNodeByIdAsync(textFrame.id);
      const resizedAutoText = await runtime.getNodeByIdAsync(autoText.id);
      append(`Flexible reparent layout: ${wrapFrame.children.map((node) => `${node.name}@${node.x},${node.y},${node.width},${node.height}`).join(";")} fillSizing=${fill.layoutSizingHorizontal}/${fill.layoutSizingVertical} align=${fill.layoutAlign}.`);
      if (
        fill.parent !== wrapFrame || fill.x !== 50 || fill.y !== 190 || fill.width !== 180 || fill.height !== 40 ||
        constraintFrame.width !== 300 || constraintFrame.height !== 200 ||
        !committedConstrained || committedConstrained.x !== 60 || committedConstrained.y !== 370 ||
        committedConstrained.width !== 200 || committedConstrained.height !== 30 ||
        committedConstrained.constraints.horizontal !== "STRETCH" || committedConstrained.constraints.vertical !== "CENTER" ||
        !resizedTextFrame || resizedTextFrame.height !== 80 || !resizedAutoText || resizedAutoText.height !== 60 || resizedAutoText.textAutoResize !== "HEIGHT"
      ) {
        append(`Reparent actual: fill=${fill.x},${fill.y},${fill.width},${fill.height} frame=${constraintFrame.width},${constraintFrame.height} constrained=${committedConstrained ? `${committedConstrained.x},${committedConstrained.y},${committedConstrained.width},${committedConstrained.height}` : "missing"}.`);
        throw new Error("Canonical reparent or constrained Frame resize did not produce the expected geometry.");
      }
      const constraintSvg = await constraintFrame.exportAsync({ format: "SVG_STRING" });
      if ((constraintSvg.match(/<path\b/g)?.length ?? 0) < 2) {
        throw new Error("Confirmed constrained Frame did not export its resized child geometry.");
      }
      append(`Auto Layout reparent, constrained Frame resize and three-line Text HUG reflow passed at revision ${reparentRevision}.`);

      const undoPromise = waitForSnapshot(
        (next) => next.revision > reparentRevision && next.nodes.some((node) => node.id === fill.id && node.parentId === flowFrame.id),
        "Auto Layout reparent Undo projection",
      );
      worker.postMessage({ type: "command", command: { type: "undo" } } satisfies MainToWorker);
      const undone = await undoPromise;
      const restoredFill = await runtime.getNodeByIdAsync(fill.id);
      const restoredConstraintFrame = await runtime.getNodeByIdAsync(constraintFrame.id);
      const restoredConstrained = await runtime.getNodeByIdAsync(constrained.id);
      const restoredTextFrame = await runtime.getNodeByIdAsync(textFrame.id);
      const restoredAutoText = await runtime.getNodeByIdAsync(autoText.id);
      if (
        !restoredFill || restoredFill.parent !== flowFrame || restoredFill.layoutSizingHorizontal !== "FILL" || restoredFill.layoutSizingVertical !== "FIXED" || restoredFill.minHeight !== null || restoredFill.maxHeight !== null || restoredFill.width !== 180 ||
        !restoredConstraintFrame || restoredConstraintFrame.width !== 200 || restoredConstraintFrame.height !== 100 ||
        !restoredConstrained || restoredConstrained.x !== 60 || restoredConstrained.y !== 320 ||
        restoredConstrained.width !== 100 || restoredConstrained.height !== 30 ||
        restoredConstrained.constraints.horizontal !== "STRETCH" || restoredConstrained.constraints.vertical !== "CENTER"
        || !restoredTextFrame || restoredTextFrame.height !== 60 || !restoredAutoText || restoredAutoText.height !== 40
        || restoredAutoText.characters !== "Alpha\nBeta" || restoredAutoText.textAutoResize !== "HEIGHT"
      ) {
        throw new Error("Undo did not restore the original Auto Layout and constrained-resize geometry.");
      }
      append(`Auto Layout reparent, constrained-resize and Text HUG Undo passed at revision ${undone.revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runImageScript = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setState("running");
    setLines([]);
    try {
      const bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9M5W8AAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      const image = await runtime.createImageAsync(bytes, "image/png", {
        timeoutMs: 10_000,
      });
      if (
        runtime.getImageByHash(image.hash)?.width !== 1 ||
        runtime.getImageByHash(image.hash)?.height !== 1
      ) {
        throw new Error(
          "Registered image metadata was not available through the Runtime hash lookup.",
        );
      }
      append(`Image resource Snapshot fence passed: ${image.hash}.`);
      const imageNode = runtime.createImageNode(image);
      imageNode.name = "M2 image surface";
      imageNode.resize(120, 80);
      imageNode.setImageAsset(image);
      const revision = await runtime.commitAsync();
      const committed = await runtime.getNodeByIdAsync(imageNode.id);
      if (!committed || committed.imageHash !== image.hash) {
        throw new Error(
          "Image asset binding did not survive the transaction fence.",
        );
      }
      append(`Image binding passed at revision ${revision}.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runViewStateScript = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setState("running");
    setLines([]);
    try {
      const rectangle = runtime.createRectangle();
      rectangle.name = "M2 selection target";
      await runtime.commitAsync();
      const sequences: number[] = [];
      const unsubscribe = runtime.onViewStateChange((viewState) =>
        sequences.push(viewState.sequence),
      );
      try {
        await runtime.currentPage.setSelectionAsync([rectangle]);
      } finally {
        unsubscribe();
      }
      if (
        runtime.currentPage.selection.map((node) => node.id).join(",") !==
          rectangle.id ||
        !sequences.length
      ) {
        throw new Error(
          "Shared selection view state did not reach the Runtime session.",
        );
      }
      append(
        `Selection view-state fence passed at sequence ${sequences.at(-1)}.`,
      );
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runImageFailureScript = async () => {
    const runtime = runtimeRef.current;
    const before = latestSnapshotRef.current?.documentHash;
    if (!runtime || !before) {
      setState("failed");
      append(
        "Canonical hash is unavailable for rejected-resource verification.",
      );
      return;
    }
    setState("running");
    setLines([]);
    try {
      await runtime.createImageAsync(Uint8Array.of(0, 1, 2, 3), "image/png", {
        timeoutMs: 10_000,
      });
      throw new Error(
        "Malformed image unexpectedly passed resource admission.",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Malformed image unexpectedly passed resource admission."
      )
        throw error;
      if (latestSnapshotRef.current?.documentHash !== before) {
        throw new Error(
          "Rejected resource admission changed the Canonical document hash.",
        );
      }
      append(`Rejected image preserved Canonical hash: ${before}.`);
      setState("passed");
    }
  };

  const runPrototypeScript = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setState("running");
    setLines([]);
    try {
      const first = runtime.createFrame();
      first.name = "M3 start screen";
      first.resize(320, 200);
      const target = runtime.createRectangle();
      target.name = "M3 click target";
      target.resize(120, 48);
      first.appendChild(target);
      const second = runtime.createFrame();
      second.name = "M3 second screen";
      second.x = 400;
      second.resize(320, 200);
      await runtime.commitAsync();
      append("M3 frames committed.");
      await first.setPrototypeMetadataAsync({ startingPoint: true });
      append("M3 prototype metadata committed.");
      await target.setReactionsAsync([
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            {
              type: "NODE",
              navigation: "NAVIGATE",
              destinationId: second.id,
              transition: { type: "DISSOLVE", duration: 120 },
            },
          ],
        },
      ]);
      append("M3 reaction mutation committed.");
      const committedTarget = await runtime.getNodeByIdAsync(target.id);
      if (!committedTarget?.reactions.length)
        throw new Error(
          "Reaction did not survive the Canonical transaction fence.",
        );
      append("Reaction persistence fence passed.");

      const player = runtime.createPrototypePlayer(first.id, {
        reducedMotion: true,
        focusableNodeIds: (frameId) =>
          frameId === first.id ? [target.id] : [],
      });
      await player.dispatchKeyboard({ key: "ENTER" });
      if (
        player.state.currentFrameId !== second.id ||
        player.state.navigationHistory.join(",") !== first.id ||
        player.state.transition
      ) {
        throw new Error(
          "RevisionLease-backed player did not deterministically navigate by keyboard with reduced motion.",
        );
      }
      append(
        `Keyboard Player navigation passed on frozen revision ${player.state.sourceRevision}.`,
      );
      runtime.createRectangle();
      await runtime.commitAsync();
      if (!player.state.stale || player.state.currentFrameId !== second.id) {
        throw new Error(
          "Editor revision advanced without preserving the player's frozen preview.",
        );
      }
      append(
        "Editor advance retained frozen Player state and exposed restart availability.",
      );
      player.close();
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runM4ExportScript = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setState("running");
    setLines([]);
    try {
      const rectangle = runtime.createRectangle();
      rectangle.name = "M4 SVG target";
      rectangle.x = 28;
      rectangle.y = 36;
      rectangle.resize(96, 48);
      const revision = await runtime.commitAsync();
      const committed = await runtime.getNodeByIdAsync(rectangle.id);
      if (!committed)
        throw new Error("M4 export target was not confirmed by the Worker.");

      // This write deliberately remains pending. exportAsync must keep using
      // the confirmed Worker projection until this mutation crosses its fence.
      committed.x = 148;
      const svg = await committed.exportAsync({ format: "SVG_STRING" });
      if (
        !svg.includes(`data-makefigma-source-revision=\"${revision}\"`) ||
        !svg.includes("matrix(1 0 0 1 28 36)") ||
        svg.includes("matrix(1 0 0 1 148 36)")
      ) {
        throw new Error(
          "M4 SVG export did not remain on its confirmed RevisionLease.",
        );
      }
      append(`SVG_STRING export used frozen revision ${revision}.`);
      const png = await committed.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 2 },
      });
      if (
        png.length < 8 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every(
          (value, index) => png[index] === value,
        )
      ) {
        throw new Error(
          "M4 PNG export did not produce a browser-encoded PNG from the frozen Scene.",
        );
      }
      append(
        `PNG export encoded ${png.byteLength} bytes from frozen revision ${revision}.`,
      );
      append(
        "Shared Scene IR preserved the confirmed target geometry while a local write was pending.",
      );
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error ? error.message : "Unknown harness failure.",
      );
    }
  };

  const runW05ExportCancellationScript = async () => {
    setState("running");
    setLines([]);
    try {
      const rectangle = {
        ...createNode("rectangle", 12, 18),
        id: "w05-cancel-export-target",
        pageId: "w05-cancel-export-page",
        width: 96,
        height: 48,
      };
      const projection = {
        revision: 73,
        nodes: [
          { id: "w05-cancel-export-document", type: "DOCUMENT" as const, name: "Document" },
          { id: "w05-cancel-export-page", type: "PAGE" as const, parentId: "w05-cancel-export-document", name: "Page" },
          { ...rectangle, type: "RECTANGLE" as const, parentId: "w05-cancel-export-page" },
        ],
      };
      let rasterSignal: AbortSignal | undefined;
      const session = new RuntimeSession({
        sessionId: "w05-browser-export-cancellation",
        projection,
        transport: {
          submit: async () => {
            throw new Error("This export-only session must not submit mutations.");
          },
        },
        scheduleMicrotask: () => undefined,
        rasterizePng: async ({ signal }) => {
          rasterSignal = signal;
          return await new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      });
      const pending = session.exportNodePng(rectangle.id, { format: "PNG" });
      for (let attempt = 0; attempt < 10 && !rasterSignal; attempt += 1) await Promise.resolve();
      if (!rasterSignal) throw new Error("PNG raster task did not start.");
      const outcome = pending.catch((error: unknown) => error);
      await session.closeAsync();
      if (!rasterSignal.aborted || !isRuntimeError(await outcome, "TASK_CANCELLED")) {
        throw new Error("Session close did not cancel and settle the PNG export task.");
      }
      append("In-flight PNG raster received an AbortSignal on session close.");
      append("closeAsync waited for TASK_CANCELLED before completing.");
      append("The cancelled export published no late PNG result.");
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown harness failure.");
    }
  };

  const runApiPrototypeCardFlowScript = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setState("running");
    setLines([]);
    try {
      const flow = await createApiPrototypeCardFlow(runtime);
      append(
        "api-prototype-card-flow: Runtime build, PendingProjection and Ack fences passed.",
      );
      const player = runtime.createPrototypePlayer(flow.listFrame.id, {
        reducedMotion: true,
        onStateChange: setPlayerDiagnostics,
        focusableNodeIds: (frameId) =>
          frameId === flow.listFrame.id
            ? [flow.detailButton.id]
            : frameId === flow.detailFrame.id
              ? [flow.overlayButton.id, flow.backButton.id]
              : [flow.overlayCloseButton.id],
      });
      try {
        await player.dispatch({
          type: "CLICK",
          targetId: flow.detailButton.id,
        });
        if (player.state.currentFrameId !== flow.detailFrame.id)
          throw new Error(
            "Card-flow click did not navigate to the detail frame.",
          );
        await player.dispatchKeyboard({ key: "ENTER" });
        if (player.state.overlays[0]?.frameId !== flow.overlayFrame.id)
          throw new Error(
            "Card-flow keyboard interaction did not open the overlay.",
          );
        await player.dispatchKeyboard({ key: "ENTER" });
        if (player.state.overlays.length)
          throw new Error(
            "Card-flow overlay did not close from its keyboard action.",
          );
        await player.dispatch({ type: "CLICK", targetId: flow.backButton.id });
        if (player.state.currentFrameId !== flow.listFrame.id)
          throw new Error(
            "Card-flow Back action did not restore the list frame.",
          );
        append(
          `api-prototype-card-flow: frozen Player replay passed at revision ${player.state.sourceRevision}.`,
        );
        // Keep this mutation pending while exporting: the SVG must remain on
        // the same confirmed revision that powered the Player lease.
        const sourceRevision = player.state.sourceRevision;
        flow.listFrame.x = 48;
        const svg = await flow.listFrame.exportAsync({ format: "SVG_STRING" });
        if (!svg.includes(`data-makefigma-source-revision="${sourceRevision}"`))
          throw new Error(
            "Card-flow export did not retain the Player's confirmed revision.",
          );
        await runtime.commitAsync();
        append(
          `api-prototype-card-flow: SVG export remained frozen at revision ${sourceRevision}.`,
        );
      } finally {
        player.close();
      }
      setState("passed");
    } catch (error) {
      setState("failed");
      append(
        error instanceof Error
          ? error.message
          : "Unknown api-prototype-card-flow failure.",
      );
    }
  };

  const runProjectionBenchmark = async () => {
    setProjectionBenchmark([]);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const results: ProjectionBenchmarkResult[] = [];
    for (const nodeCount of PF01_NODE_COUNTS) {
      const snapshot = pf01Snapshot(nodeCount);
      runtimeProjectionFromEditorSnapshot(snapshot);
      const groups: Array<{
        samplesMs: number[];
        p50Ms: number;
        p95Ms: number;
      }> = [];
      let projectedNodeCount = 0;
      for (let group = 0; group < 3; group += 1) {
        const samplesMs: number[] = [];
        for (let sample = 0; sample < 30; sample += 1) {
          const startedAt = performance.now();
          projectedNodeCount = runtimeProjectionFromEditorSnapshot(snapshot).nodes.length;
          samplesMs.push(Number((performance.now() - startedAt).toFixed(3)));
        }
        const sortedGroup = [...samplesMs].sort((left, right) => left - right);
        groups.push({
          samplesMs,
          p50Ms: percentile(sortedGroup, 0.5),
          p95Ms: percentile(sortedGroup, 0.95),
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const sorted = groups
        .flatMap((group) => group.samplesMs)
        .sort((left, right) => left - right);
      results.push({
        nodeCount,
        projectedNodeCount,
        groups,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
      });
      setProjectionBenchmark([...results]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };

  return (
    <main className="mx-auto min-h-svh max-w-3xl space-y-4 p-6 md:p-12">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>M1–M4 Runtime acceptance harness</CardTitle>
            <Badge variant="outline" data-testid="runtime-harness-state">
              State: {state}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Uses the real editor Worker to verify Runtime transactions,
            resources, shared view state, frozen prototype navigation and
            SVG/PNG export.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runCardScript()}
            >
              Run M1 card script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runRefreshHashScript()}
            >
              Run M1 refresh hash script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runComponentApiScript()}
            >
              Run M1 Component API script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runParametricGeometryScript()}
            >
              Run W12 geometry script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runBooleanGeometryScript()}
            >
              Run W12 Boolean script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runVectorNetworkScript()}
            >
              Run W12 VectorNetwork script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runSpecialNodesScript()}
            >
              Run W12 special nodes script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              data-testid="runtime-shape-paragraph-script"
              onClick={() => void runShapeWithTextParagraphScript()}
            >
              Run W12 ShapeWithText paragraph
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runTextRangeScript()}
            >
              Run W12 text range script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runEmptyTextBaseStyleScript()}
            >
              Run W12 empty text base style
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runFontNameScript()}
            >
              Run W12 FontName mapping
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              data-testid="runtime-text-case-script"
              onClick={() => void runTextCaseScript()}
            >
              Run W12 TextCase mapping
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              data-testid="runtime-text-case-shaping-script"
              onClick={() => void runTextCaseShapingScript()}
            >
              Run W12 TextCase shaping
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              data-testid="runtime-per-run-shaping-script"
              onClick={() => void runPerRunShapingScript()}
            >
              Run W12 per-run shaping
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runPaintStackScript()}
            >
              Run W12 Paint Stack script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runAutoLayoutScript()}
            >
              Run M1 Auto Layout script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runImageScript()}
            >
              Run M2 image script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runViewStateScript()}
            >
              Run M2 view-state script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runImageFailureScript()}
            >
              Run M2 rejected-image script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runPrototypeScript()}
            >
              Run M3 prototype script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runM4ExportScript()}
            >
              Run M4 SVG/PNG export script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runW05ExportCancellationScript()}
            >
              Run W05 export cancellation script
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runApiPrototypeCardFlowScript()}
            >
              Run api-prototype-card-flow
            </Button>
            <Button
              variant="outline"
              disabled={state !== "waiting-for-runtime"}
              onClick={() => void runProjectionBenchmark()}
            >
              Run PF-01 projection benchmark
            </Button>
          </div>
          {projectionBenchmark.length > 0 && (
            <section
              aria-label="PF-01 projection benchmark"
              className="rounded-lg border bg-muted/30 p-3 text-sm"
              data-testid="pf01-projection-benchmark"
              data-evidence={JSON.stringify(projectionBenchmark)}
            >
              <strong>PF-01 main-thread projection</strong>
              <pre className="mt-2 overflow-auto text-xs">
                {JSON.stringify(
                  projectionBenchmark.map(({ groups, ...result }) => ({
                    ...result,
                    groups:
                      groups?.map(({ p50Ms, p95Ms }) => ({ p50Ms, p95Ms })) ??
                      [],
                  })),
                  null,
                  2,
                )}
              </pre>
            </section>
          )}
          {playerDiagnostics && (
            <section
              aria-label="Prototype player diagnostics"
              className="rounded-lg border bg-muted/30 p-3 text-sm"
            >
              <strong>Player diagnostics</strong>
              <p className="text-muted-foreground">
                Revision {playerDiagnostics.sourceRevision} ·{" "}
                {playerDiagnostics.stale ? "stale" : "current"} ·{" "}
                {playerDiagnostics.overlays.length} overlays · queue{" "}
                {playerDiagnostics.performance.queuedInputs} · inputs{" "}
                {playerDiagnostics.performance.completedInputs} · last/max{" "}
                {playerDiagnostics.performance.lastInputMs}/
                {playerDiagnostics.performance.maxInputMs} ms
              </p>
              {playerDiagnostics.diagnostics.length > 0 && (
                <p className="text-muted-foreground">
                  Events:{" "}
                  {playerDiagnostics.diagnostics
                    .map((diagnostic) => diagnostic.code)
                    .join(", ")}
                </p>
              )}
            </section>
          )}
          <ol
            className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground"
            data-testid="runtime-harness-log"
          >
            {lines.map((line, index) => (
              <li key={`${index}:${line}`}>{line}</li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <canvas
        ref={canvasRef}
        className="sr-only"
        aria-hidden="true"
        width="1"
        height="1"
      />
    </main>
  );
}

function pf01Snapshot(nodeCount: number): EditorSnapshot {
  const pages = Array.from({ length: 4 }, (_, index) => ({
    id: `pf01-page-${index}`,
    name: `Page ${index + 1}`,
    positionId: `${(index + 1).toString(16).padStart(32, "0")}:00000000000000000000000000000000`,
  }));
  const frameCount = Math.min(100, nodeCount);
  const frames: EditorSnapshot["nodes"] = Array.from(
    { length: frameCount },
    (_, index) => ({
      id: `pf01-frame-${index}`,
      pageId: pages[index % pages.length]!.id,
      kind: "frame" as const,
      name: `Frame ${index}`,
      x: (index % 10) * 120,
      y: Math.floor(index / 10) * 120,
      width: 100,
      height: 100,
      rotation: 0,
      fill: "transparent",
      stroke: "transparent",
      radius: 0,
      strokeWidth: 0,
      opacity: 1,
      visible: true,
    }),
  );
  const leaves: EditorSnapshot["nodes"] = Array.from(
    { length: nodeCount - frameCount },
    (_, index) => {
      const parentIndex = index % frameCount;
      return {
        id: `pf01-rectangle-${index}`,
        pageId: pages[parentIndex % pages.length]!.id,
        parentId: frames[parentIndex]!.id,
        kind: "rectangle" as const,
        name: `Rectangle ${index}`,
        x: index % 100,
        y: Math.floor(index / 100),
        width: 10,
        height: 10,
        rotation: 0,
        fill: "#ffffff",
        stroke: "transparent",
        radius: 0,
        strokeWidth: 0,
        opacity: 1,
        visible: true,
      };
    },
  );
  return {
    documentId: "pf01-browser-benchmark",
    revision: 1,
    nodes: [...frames, ...leaves],
    assets: [],
    pages,
    activePageId: pages[0]!.id,
    selectedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    canUndo: false,
    canRedo: false,
    renderer: "Canvas 2D",
    documentCore: "Rust/WASM bridge ready",
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}
