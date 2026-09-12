"use client";

import { useEffect, useRef, useState } from "react";
import type {
  EditorSnapshot,
  MainToWorker,
  WorkerToMain,
} from "@/lib/editor-protocol";
import { FigmaCompatibleRuntime } from "@/runtime/figma-compatible-runtime";
import { RuntimeSession } from "@/runtime/runtime-session";
import {
  RuntimeWorkerBridge,
  runtimeProjectionFromEditorSnapshot,
} from "@/runtime/runtime-worker-bridge";
import { createApiPrototypeCardFlow } from "@/runtime/api-prototype-card-flow";
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
  const [state, setState] = useState<HarnessState>("booting");
  const [lines, setLines] = useState<string[]>([]);
  const [playerDiagnostics, setPlayerDiagnostics] =
    useState<PrototypePlayerState | null>(null);

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
      const undoSnapshotPromise = waitForSnapshot(
        (snapshot) =>
          snapshot.revision > revision &&
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
    if (!runtime) return;
    setState("running");
    setLines([]);
    try {
      const frame = runtime.createFrame();
      frame.name = "M1 vertical layout";
      frame.x = 40;
      frame.y = 60;
      frame.resize(300, 200);
      frame.layoutMode = "VERTICAL";
      frame.paddingTop = 20;
      frame.paddingRight = 20;
      frame.paddingBottom = 20;
      frame.paddingLeft = 20;
      frame.itemSpacing = 12;
      const first = runtime.createRectangle();
      first.name = "First flow item";
      first.x = 999;
      first.y = 999;
      first.resize(120, 40);
      const second = runtime.createRectangle();
      second.name = "Second flow item";
      second.x = 999;
      second.y = 999;
      second.resize(100, 60);
      frame.appendChild(first);
      frame.appendChild(second);
      if (
        frame.layoutMode !== "VERTICAL" ||
        frame.itemSpacing !== 12 ||
        first.parent !== frame ||
        second.parent !== frame
      ) {
        throw new Error(
          "PendingProjection did not preserve the Auto Layout declaration and flow children.",
        );
      }
      append(
        "Pending Auto Layout declaration and flow-child assertions passed.",
      );
      const revision = await runtime.commitAsync();
      const [committedFirst, committedSecond] = await Promise.all([
        runtime.getNodeByIdAsync(first.id),
        runtime.getNodeByIdAsync(second.id),
      ]);
      if (
        !committedFirst ||
        !committedSecond ||
        committedFirst.x !== 60 ||
        committedFirst.y !== 80 ||
        committedSecond.x !== 60 ||
        committedSecond.y !== 132
      ) {
        throw new Error(
          "Canonical Auto Layout reflow did not place both flow children deterministically.",
        );
      }
      append(`Canonical Auto Layout reflow passed at revision ${revision}.`);
      append(
        `Flow positions: (${committedFirst.x}, ${committedFirst.y}) → (${committedSecond.x}, ${committedSecond.y}).`,
      );
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
              onClick={() => void runApiPrototypeCardFlowScript()}
            >
              Run api-prototype-card-flow
            </Button>
          </div>
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
