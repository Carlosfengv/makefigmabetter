"use client";

import { useEffect, useRef, useState } from "react";
import type { EditorSnapshot, MainToWorker, WorkerToMain } from "@/lib/editor-protocol";
import { createNode } from "@/lib/editor-protocol";
import { compositeFrameDemand } from "@/lib/composite-frame-demand";
import { exportPageToSvg } from "@/lib/svg-export";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type HarnessState = "booting" | "ready" | "running" | "passed" | "failed";
type MessageWaiter = {
  predicate: (message: WorkerToMain) => boolean;
  resolve: (message: WorkerToMain) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

const SURFACE_SIZE = 3_000;
const DIAGNOSTIC_CODE = "COMPOSITE_FRAME_FRAMELIMIT";

/** Real-browser acceptance gate for W05's whole-frame failure contract. */
export function CompositeBudgetHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<EditorSnapshot | null>(null);
  const becameReadyRef = useRef(false);
  const waitersRef = useRef<MessageWaiter[]>([]);
  const readyRevisionsRef = useRef<number[]>([]);
  const [state, setState] = useState<HarnessState>("booting");
  const [lines, setLines] = useState<string[]>([]);

  const append = (line: string) => setLines((current) => [...current, line]);
  const waitForMessage = <T extends WorkerToMain>(
    predicate: (message: WorkerToMain) => message is T,
    description: string,
  ) => new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      waitersRef.current = waitersRef.current.filter((waiter) => waiter.timeoutId !== timeoutId);
      reject(new Error(`Timed out waiting for ${description}.`));
    }, 12_000);
    waitersRef.current.push({
      predicate,
      resolve: (message) => resolve(message as T),
      reject,
      timeoutId,
    });
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !("transferControlToOffscreen" in canvas)) {
      setState("failed");
      append("OffscreenCanvas is unavailable.");
      return;
    }
    const worker = new Worker(new URL("../../workers/editor.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    let disposed = false;
    worker.onmessage = ({ data }: MessageEvent<WorkerToMain>) => {
      if (data.type === "frame-ready") readyRevisionsRef.current.push(data.revision);
      if (data.type === "snapshot") {
        snapshotRef.current = data.snapshot;
        if (data.snapshot.documentCore === "Rust/WASM bridge ready" && !becameReadyRef.current) {
          becameReadyRef.current = true;
          setState("ready");
        }
      }
      const matched = waitersRef.current.filter((waiter) => waiter.predicate(data));
      waitersRef.current = waitersRef.current.filter((waiter) => !matched.includes(waiter));
      matched.forEach((waiter) => {
        window.clearTimeout(waiter.timeoutId);
        waiter.resolve(data);
      });
      if (data.type === "error" && !disposed) {
        setState("failed");
        append(`Unexpected Worker error: ${data.code}.`);
      }
    };
    worker.onerror = () => {
      if (!disposed) {
        setState("failed");
        append("Worker crashed.");
      }
    };
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({
      type: "init",
      canvas: offscreen,
      width: SURFACE_SIZE,
      height: SURFACE_SIZE,
      dpr: 1,
      documentId: "00000000-0000-0000-0000-000000000005",
      rendererPreference: "canvas2d",
      simulateGpuLosses: 0,
      simulateGpuLossAfterImage: false,
      captureFrameHash: true,
    } satisfies MainToWorker, [offscreen]);

    return () => {
      disposed = true;
      waitersRef.current.forEach((waiter) => {
        window.clearTimeout(waiter.timeoutId);
        waiter.reject(new Error("Harness disposed."));
      });
      waitersRef.current = [];
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = async () => {
    const worker = workerRef.current;
    const initial = snapshotRef.current;
    if (!worker || !initial || initial.documentCore !== "Rust/WASM bridge ready") return;
    setState("running");
    setLines([]);
    readyRevisionsRef.current = [];
    try {
      const pageId = initial.activePageId;
      const backdrop = {
        ...createNode("rectangle", 300, 300),
        id: crypto.randomUUID(),
        pageId,
        width: 1_600,
        height: 1_600,
      };
      const commitCreate = async (node: ReturnType<typeof createNode>, baseRevision: number) => {
        const snapshotPromise = waitForMessage(
          (message): message is Extract<WorkerToMain, { type: "snapshot" }> => message.type === "snapshot" && message.snapshot.revision > baseRevision && message.snapshot.nodes.some((candidate) => candidate.id === node.id),
          `create ${node.id}`,
        );
        worker.postMessage({
          type: "transaction",
          transaction: { id: crypto.randomUUID(), baseRevision, commands: [{ type: "create", node }] },
        } satisfies MainToWorker);
        return (await snapshotPromise).snapshot;
      };
      const commitMask = async (nodeId: string, baseRevision: number) => {
        const snapshotPromise = waitForMessage(
          (message): message is Extract<WorkerToMain, { type: "snapshot" }> => message.type === "snapshot" && message.snapshot.revision > baseRevision && message.snapshot.nodes.find((candidate) => candidate.id === nodeId)?.isMask === true,
          `enable mask ${nodeId}`,
        );
        worker.postMessage({
          type: "transaction",
          transaction: { id: crypto.randomUUID(), baseRevision, commands: [{ type: "setMask", id: nodeId, enabled: true }] },
        } satisfies MainToWorker);
        return (await snapshotPromise).snapshot;
      };
      let staged = await commitCreate(backdrop, initial.revision);
      append(`Backdrop created at revision ${staged.revision}.`);

      // Create parent and children through separate accepted Core revisions.
      // This also gives the test an actual 180 MB composed baseline before the
      // final leaf effect increases the frame peak to 288 MB.
      const isolated = {
        ...createNode("frame", -2_000, -2_000),
        id: crypto.randomUUID(),
        pageId,
        width: 4_000,
        height: 4_000,
        opacity: 0.5,
      };
      staged = await commitCreate(isolated, staged.revision);
      append(`Isolated Frame created at revision ${staged.revision}.`);
      const mask = {
        ...createNode("rectangle", 0, 0),
        id: crypto.randomUUID(),
        pageId,
        parentId: isolated.id,
        relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        positionId: "00000000000000000000000000000011:00000000000000000000000000000000",
        width: 4_000,
        height: 4_000,
      };
      staged = await commitCreate(mask, staged.revision);
      append(`Mask created at revision ${staged.revision}.`);
      const effected = {
        ...createNode("rectangle", 1_750, 1_750),
        id: crypto.randomUUID(),
        pageId,
        parentId: isolated.id,
        relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 1_750, f: 1_750 },
        positionId: "00000000000000000000000000000012:00000000000000000000000000000000",
        width: 500,
        height: 500,
      };
      staged = await commitCreate(effected, staged.revision);
      append(`Target created at revision ${staged.revision}.`);
      const baselineReadyPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-ready" }> => message.type === "frame-ready" && message.revision > staged.revision && message.quality === "settled",
        "composed baseline frame",
      );
      const baselineHashPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-hash" }> => message.type === "frame-hash" && message.revision > staged.revision,
        "composed baseline frame hash",
      );
      const baselineSnapshot = await commitMask(mask.id, staged.revision);
      const baselineRevision = baselineSnapshot.revision;
      append(`Mask enabled at baseline revision ${baselineRevision}.`);
      const baselineReady = await baselineReadyPromise;
      if (baselineReady.revision !== baselineRevision) throw new Error("Baseline snapshot and presented frame revisions diverged.");
      const baselineHash = await baselineHashPromise;
      if (baselineHash.revision !== baselineRevision) throw new Error("Baseline snapshot and pixel hash revisions diverged.");
      append(`180 MB baseline revision ${baselineRevision} published (${baselineHash.rgbaSha256.slice(0, 12)}…).`);

      const localEffectReadyPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-ready" }> => message.type === "frame-ready" && message.revision > baselineRevision && message.quality === "settled",
        "bounded effect frame",
      );
      const localEffectHashPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-hash" }> => message.type === "frame-hash" && message.revision > baselineRevision,
        "bounded effect frame hash",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: baselineRevision,
          commands: [{ type: "update", id: effected.id, patch: { effectStack: [{ layerBlur: { radius: 12, visible: true } }] } }],
        },
      } satisfies MainToWorker);
      const localEffectReady = await localEffectReadyPromise;
      const localEffectHash = await localEffectHashPromise;
      if (localEffectHash.rgbaSha256 === baselineHash.rgbaSha256) throw new Error("Bounded effect did not change the presented pixels.");
      append(`Local Layer Blur published revision ${localEffectReady.revision} (${localEffectHash.rgbaSha256.slice(0, 12)}…) beside the 180 MB structural pools.`);

      const failedFramePromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-failed" }> => message.type === "frame-failed" && message.revision > localEffectReady.revision,
        "over-budget frame rejection",
      );
      const failedSnapshotPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "snapshot" }> => message.type === "snapshot" && message.snapshot.revision > localEffectReady.revision && message.snapshot.diagnostics?.recent.some((event) => event.code === DIAGNOSTIC_CODE) === true,
        "over-budget diagnostic snapshot",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: localEffectReady.revision,
          commands: [{ type: "update", id: effected.id, patch: { width: 4_000, height: 4_000, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } } }],
        },
      } satisfies MainToWorker);
      const failedFrame = await failedFramePromise;
      const failedSnapshot = (await failedSnapshotPromise).snapshot;
      if (failedFrame.retainedRevision !== localEffectReady.revision) throw new Error("Rejected frame did not retain the local-effect revision.");
      if (readyRevisionsRef.current.includes(failedFrame.revision)) throw new Error("Rejected revision incorrectly published frame-ready.");
      const firstDiagnosticCount = failedSnapshot.diagnostics?.recent.filter((event) => event.code === DIAGNOSTIC_CODE).length ?? 0;
      if (firstDiagnosticCount !== 1) throw new Error(`Expected one resource diagnostic, received ${firstDiagnosticCount}.`);
      append(`Viewport-sized effect revision ${failedFrame.revision} rejected at 288 MB peak; revision ${failedFrame.retainedRevision} remained presented.`);

      const repeatedFailurePromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-failed" }> => message.type === "frame-failed" && message.revision === failedFrame.revision,
        "repeated rejected paint",
      );
      const repeatedSnapshotPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "snapshot" }> => message.type === "snapshot" && message.snapshot.revision === failedFrame.revision,
        "repeated diagnostic snapshot",
      );
      worker.postMessage({ type: "visibility", visible: false } satisfies MainToWorker);
      worker.postMessage({ type: "visibility", visible: true } satisfies MainToWorker);
      await repeatedFailurePromise;
      const repeatedSnapshot = (await repeatedSnapshotPromise).snapshot;
      const repeatedCount = repeatedSnapshot.diagnostics?.recent.filter((event) => event.code === DIAGNOSTIC_CODE).length ?? 0;
      if (repeatedCount !== 1) throw new Error(`Repeated paint emitted ${repeatedCount} resource diagnostics.`);
      append("Repeated paint preserved the old frame and did not duplicate the diagnostic.");

      const retryReadyPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-ready" }> => message.type === "frame-ready" && message.revision > failedFrame.revision && message.quality === "settled",
        "successful reduced-demand retry",
      );
      const retryHashPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-hash" }> => message.type === "frame-hash" && message.revision > failedFrame.revision,
        "retry frame hash",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: failedFrame.revision,
          commands: [
            { type: "update", id: isolated.id, patch: { x: -300, y: -300, width: 700, height: 700, opacity: 1 } },
            { type: "update", id: mask.id, patch: { width: 500, height: 500, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 50 } } },
            { type: "update", id: effected.id, patch: { width: 500, height: 500, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 100 }, effectStack: [] } },
          ],
        },
      } satisfies MainToWorker);
      const retryReady = await retryReadyPromise;
      const retryHash = await retryHashPromise;
      if (retryHash.rgbaSha256 === baselineHash.rgbaSha256) throw new Error("Successful retry did not change the presented pixels.");
      append(`Reduced-demand retry published revision ${retryReady.revision} (${retryHash.rgbaSha256.slice(0, 12)}…).`);

      const resizedReadyPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-ready" }> => message.type === "frame-ready" && message.revision === retryReady.revision && message.quality === "settled",
        "800px nested-composite surface",
      );
      worker.postMessage({ type: "resize", width: 800, height: 800, dpr: 1 } satisfies MainToWorker);
      await resizedReadyPromise;
      staged = snapshotRef.current!;
      const innerFrame = {
        ...createNode("frame", 150, 150),
        id: crypto.randomUUID(),
        pageId,
        parentId: isolated.id,
        relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 150, f: 150 },
        width: 300,
        height: 300,
        clipsContent: false,
      };
      staged = await commitCreate(innerFrame, staged.revision);
      const innerMask = {
        ...createNode("ellipse", 30, 30),
        id: crypto.randomUUID(),
        pageId,
        parentId: innerFrame.id,
        relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 30 },
        positionId: "00000000000000000000000000000021:00000000000000000000000000000000",
        width: 220,
        height: 220,
      };
      staged = await commitCreate(innerMask, staged.revision);
      const innerTarget = {
        ...createNode("rectangle", 80, 80),
        id: crypto.randomUUID(),
        pageId,
        parentId: innerFrame.id,
        relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 80, f: 80 },
        positionId: "00000000000000000000000000000022:00000000000000000000000000000000",
        width: 120,
        height: 120,
      };
      staged = await commitCreate(innerTarget, staged.revision);
      const nestedBaselineBaseRevision = staged.revision;
      const nestedBaselineHashPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-hash" }> => message.type === "frame-hash" && message.revision > nestedBaselineBaseRevision,
        "nested-mask baseline hash",
      );
      staged = await commitMask(innerMask.id, staged.revision);
      const nestedBaselineHash = await nestedBaselineHashPromise;
      if (nestedBaselineHash.revision !== staged.revision) throw new Error("Nested-mask baseline hash revision diverged.");

      const nestedEffectBaseRevision = staged.revision;
      const nestedReadyPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-ready" }> => message.type === "frame-ready" && message.revision > nestedEffectBaseRevision && message.quality === "settled",
        "nested mask plus effect frame",
      );
      const nestedHashPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "frame-hash" }> => message.type === "frame-hash" && message.revision > nestedEffectBaseRevision,
        "nested mask plus effect hash",
      );
      const nestedSnapshotPromise = waitForMessage(
        (message): message is Extract<WorkerToMain, { type: "snapshot" }> => message.type === "snapshot" && message.snapshot.revision > nestedEffectBaseRevision && message.snapshot.nodes.find((node) => node.id === innerTarget.id)?.effectStack?.length === 1,
        "nested mask plus effect projection",
      );
      worker.postMessage({
        type: "transaction",
        transaction: {
          id: crypto.randomUUID(),
          baseRevision: nestedEffectBaseRevision,
          commands: [{
            type: "update",
            id: innerTarget.id,
            patch: {
              effectStack: [{
                dropShadow: {
                  offsetX: 28,
                  offsetY: 24,
                  blurRadius: 16,
                  spread: 4,
                  color: { space: "srgb", components: [0, 0, 0], alpha: 0.8 },
                  visible: true,
                },
              }],
            },
          }],
        },
      } satisfies MainToWorker);
      const nestedReady = await nestedReadyPromise;
      const nestedHash = await nestedHashPromise;
      const nestedSnapshot = (await nestedSnapshotPromise).snapshot;
      if (nestedHash.revision !== nestedReady.revision || nestedSnapshot.revision !== nestedReady.revision)
        throw new Error("Nested mask/effect frame, hash and projection revisions diverged.");
      if (nestedHash.rgbaSha256 === nestedBaselineHash.rgbaSha256)
        throw new Error("Drop Shadow inside the nested masks did not change the final pixels.");
      const demand = compositeFrameDemand(nestedSnapshot.nodes);
      if (demand.effectPool !== true || demand.alphaMaskPools !== 2 || demand.surfaces !== 7)
        throw new Error(`Nested mask/effect demand diverged: ${JSON.stringify(demand)}.`);
      const nestedSvg = exportPageToSvg(nestedSnapshot.nodes, {
        pageId,
        defaultPageId: pageId,
        sourceRevision: nestedSnapshot.revision,
        padding: 0,
      });
      if ((nestedSvg.svg.match(/<mask id="makefigma-alpha-mask-/g) ?? []).length !== 2
        || !nestedSvg.svg.includes('id="makefigma-drop-shadow-')
        || nestedSvg.compatibilityFallbacks.length !== 0)
        throw new Error("Nested mask/effect SVG did not preserve both alpha scopes and the Drop Shadow filter.");
      append(`Nested mask + Drop Shadow published revision ${nestedReady.revision}; 7-surface pixel hash changed ${nestedBaselineHash.rgbaSha256.slice(0, 12)}… → ${nestedHash.rgbaSha256.slice(0, 12)}…, SVG kept two masks and one filter.`);
      setState("passed");
    } catch (error) {
      setState("failed");
      append(error instanceof Error ? error.message : "Unknown harness failure.");
      const latest = snapshotRef.current;
      if (latest) {
        const demand = compositeFrameDemand(latest.nodes);
        append(`Latest projection revision ${latest.revision}; demand=${JSON.stringify(demand)}; ready=${readyRevisionsRef.current.join(",")}.`);
      }
    }
  };

  return (
    <main className="mx-auto min-h-svh max-w-3xl space-y-4 p-6 md:p-12">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>W05 Canvas composite budget gate</CardTitle>
            <Badge variant="outline" data-testid="composite-budget-state">State: {state}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">Real 3000×3000 Worker surface; eight simultaneous RGBA composition buffers require 288 MB.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button disabled={state !== "ready"} onClick={() => void run()}>Run W05 browser gate</Button>
          <canvas ref={canvasRef} width="300" height="300" className="aspect-square w-full max-w-sm rounded border bg-muted" />
          <ol className="space-y-1 rounded border bg-muted/30 p-3 text-sm text-muted-foreground" data-testid="composite-budget-log">
            {lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
          </ol>
        </CardContent>
      </Card>
    </main>
  );
}
