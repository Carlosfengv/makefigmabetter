"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { appendLocalJournalEntry, loadLocalDocument, prepareLocalStorage, saveLocalDocument } from "@/lib/local-document";
import { createId, documentColorFromCssHex, type CanvasNode, type CoreLocalSnapshot, type DocumentColor, type DocumentLinearGradient, type EditorCommand, type EditorInputEvent, type EditorSnapshot, type MainToWorker, type NodeKind, type RendererPreference, type ToolKind, type WorkerToMain } from "@/lib/editor-protocol";
import { maintainWriterLease, type WriterLeaseMode } from "@/lib/writer-lease";
import { planWorkerRecovery } from "@/lib/worker-recovery";
import { colorToOpaqueSrgbCss, colorToSrgbCss, createDefaultLinearGradient } from "@/lib/color-rendering";
import { createInputTransferBatcher, type InputTransferBatcher } from "@/lib/input-transfer-batcher";
import { emptyMainThreadLongTaskSummary, recordMainThreadLongTask, type MainThreadLongTaskSummary } from "@/lib/main-thread-health";
import { encodeInputBatch } from "@/lib/input-transfer";
import { createEditorTransactionQueue } from "@/lib/editor-transaction-queue";
import { applyOptimisticUpdates, type OptimisticUpdate } from "@/lib/optimistic-projection";
import phase0BasicCardFixture from "../../../fixtures/documents/phase0-basic-card.fixture.json";

const tools: Array<{ id: ToolKind; label: string; glyph: string; key: string }> = [
  { id: "select", label: "Move", glyph: "↖", key: "V" },
  { id: "hand", label: "Pan", glyph: "✋", key: "H" },
  { id: "frame", label: "Frame", glyph: "#", key: "F" },
  { id: "rectangle", label: "Rectangle", glyph: "□", key: "R" },
  { id: "ellipse", label: "Ellipse", glyph: "○", key: "O" },
  { id: "text", label: "Text", glyph: "T", key: "T" },
];

const blankSnapshot: EditorSnapshot = { revision: 0, nodes: [], selectedIds: [], viewport: { x: 0, y: 0, zoom: 1 }, canUndo: false, canRedo: false, renderer: "Canvas 2D", documentCore: "Starting Rust/WASM bridge" };
const writerLockName = "makefigma:starter-document";
type TabMessage = { type: "snapshot"; snapshot: CoreLocalSnapshot };

function requestedFixtureSnapshot(): Extract<EditorCommand, { type: "hydrate" }> ["snapshot"] | undefined {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("fixture") !== "phase0-basic-card") return undefined;
  return {
    format: "legacy-projection-v0",
    nodes: structuredClone(phase0BasicCardFixture.nodes) as CanvasNode[],
    viewport: structuredClone(phase0BasicCardFixture.viewport),
  };
}

function requestedRendererPreference(): RendererPreference {
  if (typeof window === "undefined") return "auto";
  return new URLSearchParams(window.location.search).get("renderer") === "canvas2d" ? "canvas2d" : "auto";
}

function requestedGpuLossSimulationCount(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return 0;
  const search = new URLSearchParams(window.location.search);
  if (search.get("fixture") !== "phase0-basic-card") return 0;
  const requested = Number(search.get("simulateGpuLoss"));
  return Number.isInteger(requested) ? Math.min(2, Math.max(0, requested)) : 0;
}

function requestedEngineCrashSimulationCount(): number {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return 0;
  const search = new URLSearchParams(window.location.search);
  if (search.get("fixture") !== "phase0-basic-card") return 0;
  const requested = Number(search.get("simulateWorkerCrash"));
  return Number.isInteger(requested) ? Math.min(2, Math.max(0, requested)) : 0;
}

function changesDocument(command: EditorCommand) {
  return command.type !== "select";
}

export function EditorShell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const restoredRef = useRef(false);
  const revisionRef = useRef(0);
  const snapshotRef = useRef<EditorSnapshot>(blankSnapshot);
  const confirmedSnapshotRef = useRef<EditorSnapshot>(blankSnapshot);
  const recoverySnapshotRef = useRef<CoreLocalSnapshot | undefined>(undefined);
  const recoveryFailuresRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recoveryStabilityTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewportCheckpointTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persistenceQueue = useRef(Promise.resolve());
  const writerRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const inputBatcherRef = useRef<InputTransferBatcher | null>(null);
  const transactionQueueRef = useRef<ReturnType<typeof createEditorTransactionQueue> | null>(null);
  const optimisticUpdatesRef = useRef(new Map<string, OptimisticUpdate>());
  const simulatedWorkerCrashesRef = useRef(0);
  const [snapshot, setSnapshot] = useState<EditorSnapshot>(blankSnapshot);
  const [tool, setTool] = useState<ToolKind>("select");
  const [status, setStatus] = useState("Starting engine");
  const [storageNotice, setStorageNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [writerMode, setWriterMode] = useState<WriterLeaseMode>("acquiring");
  const [accessPreference, setAccessPreference] = useState<"edit" | "view">("edit");
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [safeMode, setSafeMode] = useState(false);
  const [mainThreadLongTasks, setMainThreadLongTasks] = useState<MainThreadLongTaskSummary>(emptyMainThreadLongTaskSummary);
  const [mainThreadMonitor, setMainThreadMonitor] = useState<"waiting" | "monitoring" | "unavailable">("waiting");
  const [mainThreadMonitoringEnabled, setMainThreadMonitoringEnabled] = useState(false);
  const fixtureSnapshot = useMemo(() => requestedFixtureSnapshot(), []);
  const rendererPreference = useMemo(() => requestedRendererPreference(), []);
  const simulateGpuLosses = useMemo(() => requestedGpuLossSimulationCount(), []);
  const simulateWorkerCrashes = useMemo(() => requestedEngineCrashSimulationCount(), []);

  const post = useCallback((message: MainToWorker, transfer?: Transferable[]) => workerRef.current?.postMessage(message, transfer ?? []), []);
  const postInput = useCallback((events: readonly EditorInputEvent[]) => {
    const buffer = encodeInputBatch(events);
    workerRef.current?.postMessage({ type: "input", buffer } satisfies MainToWorker, [buffer]);
  }, []);
  const command = useCallback((next: EditorCommand) => {
    if (safeMode) { setStatus("Engine worker safe mode · reload to retry"); return; }
    if (changesDocument(next) && !writerRef.current) { setStatus("Engine worker online · read-only tab"); return; }
    const transactionId = transactionQueueRef.current?.enqueue([next]);
    if (transactionId && next.type === "update") {
      optimisticUpdatesRef.current.set(transactionId, next);
      const projected = applyOptimisticUpdates(confirmedSnapshotRef.current, optimisticUpdatesRef.current.values());
      snapshotRef.current = projected;
      setSnapshot(projected);
    }
  }, [safeMode]);

  const recoverWorker = useCallback((reason: "error" | "message-error") => {
    if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current);
    const plan = planWorkerRecovery(recoveryFailuresRef.current);
    if (plan.mode === "safe-mode") {
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      workerRef.current?.terminate();
      workerRef.current = null;
      setSafeMode(true);
      setError("Engine Worker 连续异常，已进入安全模式；已确认的本地快照保持不变，请刷新后重试。");
      setStatus("Engine worker safe mode");
      return;
    }
    recoveryFailuresRef.current = plan.nextFailures;
    transactionQueueRef.current?.reset();
    optimisticUpdatesRef.current.clear();
    recoverySnapshotRef.current ??= snapshotRef.current.localSnapshot;
    workerRef.current?.terminate();
    workerRef.current = null;
    setError(undefined);
    setStatus(`Engine worker recovering after ${reason}`);
    recoveryTimerRef.current = setTimeout(() => setCanvasGeneration((generation) => generation + 1), 150);
  }, []);

  useEffect(() => () => {
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current);
    if (viewportCheckpointTimerRef.current) clearTimeout(viewportCheckpointTimerRef.current);
  }, []);

  useEffect(() => {
    const queue = createEditorTransactionQueue({
      createId,
      currentRevision: () => revisionRef.current,
      send: (transaction) => {
        const worker = workerRef.current;
        if (!worker) return false;
        worker.postMessage({ type: "transaction", transaction } satisfies MainToWorker);
        return true;
      },
    });
    transactionQueueRef.current = queue;
    return () => {
      queue.reset();
      if (transactionQueueRef.current === queue) transactionQueueRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mainThreadMonitoringEnabled) return;
    if (!("PerformanceObserver" in globalThis)) {
      const unavailable = setTimeout(() => setMainThreadMonitor("unavailable"), 0);
      return () => clearTimeout(unavailable);
    }
    try {
      const observer = new PerformanceObserver((entries) => {
        setMainThreadLongTasks((current) => entries.getEntries().reduce(
          (summary, entry) => recordMainThreadLongTask(summary, entry.duration),
          current,
        ));
      });
      observer.observe({ type: "longtask" });
      return () => observer.disconnect();
    } catch {
      const unavailable = setTimeout(() => setMainThreadMonitor("unavailable"), 0);
      return () => clearTimeout(unavailable);
    }
  }, [mainThreadMonitoringEnabled]);

  useEffect(() => {
    const batcher = createInputTransferBatcher((events) => postInput(events));
    inputBatcherRef.current = batcher;
    return () => {
      batcher.dispose();
      if (inputBatcherRef.current === batcher) inputBatcherRef.current = null;
    };
  }, [postInput]);

  useEffect(() => {
    const channel = new BroadcastChannel(writerLockName);
    channelRef.current = channel;
    channel.onmessage = ({ data }: MessageEvent<TabMessage>) => {
      if (data.type === "snapshot" && !writerRef.current) {
        post({ type: "command", command: { type: "hydrate", snapshot: data.snapshot } });
        setStatus("Engine worker online · read-only copy updated");
      }
    };
    if (accessPreference === "view") {
      writerRef.current = false;
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      return () => {
        channel.close();
        channelRef.current = null;
      };
    }
    if (!navigator.locks) {
      queueMicrotask(() => {
        setWriterMode("read-only");
        setStatus("Engine worker online · Web Locks unavailable (read-only)");
      });
    } else {
      const lease = maintainWriterLease({
        name: writerLockName,
        request: async (name, callback) => {
          await navigator.locks!.request(name, { ifAvailable: true }, async (lock) => callback(lock));
        },
        onMode: (mode) => {
          writerRef.current = mode === "owner";
          setWriterMode(mode);
          if (mode === "owner") setStatus("Engine worker online · writer lease acquired");
          if (mode === "read-only") setStatus("Engine worker online · following local writer");
        },
      });
      return () => {
        writerRef.current = false;
        transactionQueueRef.current?.reset();
        // Keep the Web Lock until every snapshot accepted while this tab was
        // owner has finished. This fences an old owner's queued Manifest writes
        // from a newly promoted tab.
        void persistenceQueue.current.catch(() => undefined).finally(() => {
          lease.stop();
          channel.close();
          if (channelRef.current === channel) channelRef.current = null;
        });
      };
    }
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [accessPreference, post]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!("transferControlToOffscreen" in canvas)) { setError("此浏览器不支持 OffscreenCanvas，无法启动独立画布引擎。"); return; }
    const worker = new Worker(new URL("../../workers/editor.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    let disposed = false;
    let crashSimulationTimer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => post({ type: "resize", width: canvas.clientWidth, height: canvas.clientHeight, dpr: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    worker.onmessage = async ({ data }: MessageEvent<WorkerToMain>) => {
      if (data.type === "ready") {
        setStatus("Engine worker online");
        setMainThreadLongTasks(emptyMainThreadLongTaskSummary());
        setMainThreadMonitor("monitoring");
        setMainThreadMonitoringEnabled(true);
        void prepareLocalStorage().then((health) => {
          if (health.lowSpace) setStorageNotice("local storage space low");
          else if (!health.persistentStorageGranted) setStorageNotice("browser may evict local data");
          else if (!health.opfsAvailable) setStorageNotice("IndexedDB snapshot fallback");
        }).catch(() => setStorageNotice("local storage status unavailable"));
        try {
          const recoverySnapshot = recoverySnapshotRef.current;
          const local = recoverySnapshot ?? fixtureSnapshot ?? await loadLocalDocument();
          if (local) {
            if (recoverySnapshot) setStatus("Engine worker online · recovered confirmed snapshot");
            else if (fixtureSnapshot) setStatus("Engine worker online · fixed Phase 0 fixture loaded");
            else if ("recoveredFromPrevious" in local && local.recoveredFromPrevious) setStatus("Engine worker online · restored previous local snapshot");
            post({ type: "command", command: { type: "hydrate", snapshot: local } });
          }
        } catch { setStatus("Engine worker online · local save unavailable"); }
        restoredRef.current = true;
      }
      if (data.type === "snapshot") {
        revisionRef.current = data.snapshot.revision;
        confirmedSnapshotRef.current = data.snapshot;
        const projectedSnapshot = applyOptimisticUpdates(data.snapshot, optimisticUpdatesRef.current.values());
        snapshotRef.current = projectedSnapshot;
        if (data.snapshot.localSnapshot) {
          recoverySnapshotRef.current = data.snapshot.localSnapshot;
          setSafeMode(false);
          if (recoveryFailuresRef.current > 0) {
            if (recoveryStabilityTimerRef.current) clearTimeout(recoveryStabilityTimerRef.current);
            recoveryStabilityTimerRef.current = setTimeout(() => { recoveryFailuresRef.current = 0; }, 5_000);
          }
        }
        setSnapshot(projectedSnapshot);
        if (data.snapshot.localSnapshot && simulatedWorkerCrashesRef.current < simulateWorkerCrashes && !crashSimulationTimer) {
          simulatedWorkerCrashesRef.current += 1;
          crashSimulationTimer = setTimeout(() => {
            if (!disposed && workerRef.current === worker) worker.postMessage({ type: "simulate-crash" } satisfies MainToWorker);
          }, 100);
        }
        if (restoredRef.current && writerRef.current && !fixtureSnapshot && data.snapshot.localSnapshot) {
          const { localJournalEntry, localSnapshot } = data.snapshot;
          persistenceQueue.current = persistenceQueue.current
            .catch(() => undefined)
            .then(async () => {
              if (localJournalEntry) await appendLocalJournalEntry(localJournalEntry);
              await saveLocalDocument(localSnapshot);
              channelRef.current?.postMessage({ type: "snapshot", snapshot: localSnapshot } satisfies TabMessage);
            })
            .catch((reason: unknown) => setStatus(reason instanceof Error && reason.message === "LOCAL_STORAGE_QUOTA_EXCEEDED" ? "Engine worker online · local storage is full" : "Engine worker online · save paused"));
        }
      }
      if (data.type === "view-state") {
        const confirmedSnapshot = { ...confirmedSnapshotRef.current, viewport: data.viewport, selectedIds: data.selectedIds, performance: data.performance };
        confirmedSnapshotRef.current = confirmedSnapshot;
        const nextSnapshot = applyOptimisticUpdates(confirmedSnapshot, optimisticUpdatesRef.current.values());
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        if (data.viewportChanged && restoredRef.current && writerRef.current && !fixtureSnapshot) {
          if (viewportCheckpointTimerRef.current) clearTimeout(viewportCheckpointTimerRef.current);
          viewportCheckpointTimerRef.current = setTimeout(() => {
            viewportCheckpointTimerRef.current = undefined;
            if (writerRef.current) post({ type: "checkpoint" });
          }, 500);
        }
      }
      if (data.type === "ack") {
        if (data.acceptedRevision !== undefined) revisionRef.current = data.acceptedRevision;
        const acknowledgement = transactionQueueRef.current?.acknowledge(data);
        if (acknowledgement?.handled && !acknowledgement.retried) {
          optimisticUpdatesRef.current.delete(data.transactionId);
          const projected = applyOptimisticUpdates(confirmedSnapshotRef.current, optimisticUpdatesRef.current.values());
          snapshotRef.current = projected;
          setSnapshot(projected);
        }
        if (data.errorCode) setStatus(`Engine worker online · ${data.errorCode.toLowerCase().replaceAll("_", " ")}`);
      }
      if (data.type === "tool") setTool(data.tool);
      if (data.type === "error") {
        revisionRef.current = data.documentRevision;
        setError(data.safeMessage);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (!disposed) recoverWorker("error");
    };
    worker.onmessageerror = () => {
      if (!disposed) recoverWorker("message-error");
    };
    const offscreen = canvas.transferControlToOffscreen();
    post({ type: "init", canvas: offscreen, width: canvas.clientWidth, height: canvas.clientHeight, dpr: window.devicePixelRatio || 1, rendererPreference, simulateGpuLosses }, [offscreen]);
    return () => { disposed = true; if (crashSimulationTimer) clearTimeout(crashSimulationTimer); observer.disconnect(); worker.terminate(); if (workerRef.current === worker) workerRef.current = null; };
  }, [canvasGeneration, fixtureSnapshot, post, recoverWorker, rendererPreference, simulateGpuLosses, simulateWorkerCrashes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const input: EditorInputEvent = { type: "wheel", x: event.clientX - rect.left, y: event.clientY - rect.top, deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey || event.metaKey };
      const batcher = inputBatcherRef.current;
      if (batcher) batcher.enqueue(input);
      else postInput([input]);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [canvasGeneration, postInput]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches("input, textarea")) return;
      const match = tools.find((entry) => entry.key.toLowerCase() === event.key.toLowerCase());
      if (safeMode) return;
      if (match && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        if (writerRef.current || match.id === "select" || match.id === "hand") {
          setTool(match.id);
          post({ type: "tool", tool: match.id });
        } else setStatus("Engine worker online · read-only tab");
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") event.preventDefault();
      if (writerRef.current) post({ type: "key", key: event.key, metaKey: event.metaKey || event.ctrlKey, shiftKey: event.shiftKey });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [post, safeMode]);

  const selected = useMemo(() => snapshot.nodes.find((node) => snapshot.selectedIds.includes(node.id)), [snapshot]);
  const canEdit = accessPreference === "edit" && writerMode === "owner" && !safeMode;
  const accessLabel = safeMode
    ? "安全模式"
    : accessPreference === "view"
      ? "只读"
      : writerMode === "owner"
        ? "可编辑"
        : "申请编辑中";
  const renderEvidence = snapshot.performance?.samples ? `render P95 ${snapshot.performance.p95Ms.toFixed(1)}ms · ${snapshot.diagnostics?.total ?? 0} diagnostics` : "collecting render evidence";
  const mainThreadEvidence = mainThreadMonitor === "waiting"
    ? "main task monitor starting"
    : mainThreadMonitor === "unavailable"
    ? "main-task monitor unavailable"
    : mainThreadLongTasks.count
      ? `main ${mainThreadLongTasks.count} long tasks · worst ${mainThreadLongTasks.maxDurationMs.toFixed(0)}ms`
      : "main 0 long tasks";
  const resourceEvidence = snapshot.resources ? `${snapshot.resources.documentNodes}/${snapshot.resources.maxDocumentNodes} nodes · ${(snapshot.resources.documentBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxDocumentBytes / 1024 / 1024).toFixed(0)} MB document · ${(snapshot.resources.wasmHeapBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxWasmHeapBytes / 1024 / 1024).toFixed(0)} MB WASM · ${(snapshot.resources.renderSurfaceBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxRenderSurfaceBytes / 1024 / 1024).toFixed(0)} MB surface · ${(snapshot.resources.gpuSceneBytes / 1024 / 1024).toFixed(1)}/${(snapshot.resources.maxGpuSceneBytes / 1024 / 1024).toFixed(0)} MB GPU scene${snapshot.resources.gpuSceneWithinBudget ? "" : " (Canvas fallback)"}` : "collecting resource evidence";
  const setActiveTool = (next: ToolKind) => {
    if (safeMode) return;
    if (!writerRef.current && next !== "select" && next !== "hand") {
      setStatus("Engine worker online · read-only tab");
      return;
    }
    setTool(next);
    post({ type: "tool", tool: next });
  };
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, type: "down" | "move" | "up") => {
    if (safeMode) return;
    const readOnly = !writerRef.current;
    if (readOnly && tool !== "select" && tool !== "hand") {
      setStatus("Engine worker online · read-only tab");
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const packet: EditorInputEvent = { type: "pointer", event: type, x: event.clientX - rect.left, y: event.clientY - rect.top, shiftKey: event.shiftKey, button: event.button, ...(readOnly ? { readOnly: true } : {}) };
    if (type === "move") {
      const batcher = inputBatcherRef.current;
      if (batcher) batcher.enqueue(packet);
      else postInput([packet]);
      return;
    }
    const batcher = inputBatcherRef.current;
    if (batcher) batcher.flushWith(packet);
    else postInput([packet]);
  };
  const update = (patch: Partial<CanvasNode>) => {
    if (patch.strokeWidth !== undefined && (!Number.isFinite(patch.strokeWidth) || patch.strokeWidth < 0)) return;
    if (patch.rotation !== undefined && !Number.isFinite(patch.rotation)) return;
    if (selected) command({ type: "update", id: selected.id, patch });
  };
  const selectCreationTool = (kind: NodeKind) => setActiveTool(kind);
  const setAccessMode = (next: "edit" | "view") => {
    if (next === accessPreference) return;
    if (next === "view") {
      writerRef.current = false;
      transactionQueueRef.current?.reset();
      optimisticUpdatesRef.current.clear();
      setWriterMode("read-only");
      setStatus("Engine worker online · view-only mode");
    } else {
      setWriterMode("acquiring");
      setStatus("Engine worker online · requesting edit access");
    }
    setAccessPreference(next);
  };

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">M</span><span>MAKE / FIGMA</span><small>alpha 01</small></div>
        <div className="document-name"><span className="sync-dot" />Orbit card exploration <span>• saved locally</span></div>
        <div className="top-actions">
          <div className="access-toggle" role="group" aria-label="Document access mode">
            <button type="button" aria-pressed={accessPreference === "view"} onClick={() => setAccessMode("view")}>只读</button>
            <button type="button" aria-pressed={accessPreference === "edit"} onClick={() => setAccessMode("edit")} disabled={safeMode}>编辑</button>
            <span className={`access-state ${canEdit ? "is-editable" : ""}`} aria-live="polite">{accessLabel}</span>
          </div>
          <span className="engine-status">{snapshot.renderer} · {snapshot.gpu?.webgpu === "ready" ? snapshot.resources?.gpuSceneWithinBudget === false ? "GPU scene resource fallback" : snapshot.gpu.recoveryAttempts ? `WebGPU scene recovered (${snapshot.gpu.recoveryAttempts})` : "WebGPU scene active" : snapshot.gpu?.webgpu === "recovering" ? "recovering WebGPU scene" : snapshot.gpu?.webgpu === "unavailable" ? snapshot.gpu.recoveryAttempts ? `WebGPU recovery exhausted · ${snapshot.gpu.webgl2Available ? "WebGL2 available" : "GPU fallback"}` : (snapshot.gpu.webgl2Available ? "WebGL2 available" : "GPU fallback") : "checking GPU"} · {snapshot.documentCore} · {writerMode === "owner" ? "local writer" : writerMode === "read-only" ? "read-only tab" : "acquiring writer lock"} · {status}{storageNotice ? ` · ${storageNotice}` : ""}</span>
          <button className="quiet-button" disabled={!canEdit} onClick={() => command({ type: "reset" })}>Reset demo</button>
          <button className="publish-button">Share <span>↗</span></button>
        </div>
      </header>

      <aside className="tool-rail" aria-label="Canvas tools">
        {tools.map((item) => <IconButton key={item.id} label={`${item.label} (${item.key})`} active={tool === item.id} disabled={safeMode || (!canEdit && item.id !== "select" && item.id !== "hand")} onClick={() => setActiveTool(item.id)}><span>{item.glyph}</span><i>{item.key}</i></IconButton>)}
        <div className="rail-spacer" />
        <IconButton label="Zoom in" disabled={safeMode} onClick={() => { const input: EditorInputEvent = { type: "wheel", x: window.innerWidth / 2, y: window.innerHeight / 2, deltaX: 0, deltaY: -100, ctrlKey: true }; const batcher = inputBatcherRef.current; if (batcher) batcher.enqueue(input); else postInput([input]); }}>+</IconButton>
      </aside>

      <section className="layers-panel panel" aria-label="Layers">
        <div className="panel-heading"><span>Layers</span><button disabled={!canEdit} onClick={() => selectCreationTool("frame")} aria-label="Create frame">+</button></div>
        <div className="page-label"><span className="page-square" />Page 1</div>
        <div className="layer-list">
          {[...snapshot.nodes].reverse().map((node) => <button key={node.id} className={`layer-row ${snapshot.selectedIds.includes(node.id) ? "selected" : ""}`} onClick={() => command({ type: "select", ids: [node.id] })}>
            <span className={`node-icon ${node.kind}`}>{node.kind === "ellipse" ? "○" : node.kind === "text" ? "T" : node.kind === "frame" ? "#" : "□"}</span><span>{node.name}</span><span className="layer-visibility">{node.visible === false ? "○" : "◉"}</span>
          </button>)}
        </div>
        <div className="quick-add">
          <p>New layer</p>
          <div><button disabled={!canEdit} onClick={() => selectCreationTool("rectangle")}>Rectangle</button><button disabled={!canEdit} onClick={() => selectCreationTool("text")}>Text</button></div>
        </div>
      </section>

      <section className="canvas-wrap" aria-label="Design canvas">
        <canvas key={`editor-canvas-${canvasGeneration}`} ref={canvasRef} className="design-canvas" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer(event, "down"); }} onPointerMove={(event) => pointer(event, "move")} onPointerUp={(event) => { pointer(event, "up"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={(event) => { pointer(event, "up"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
        <div className="canvas-caption"><span>WORLD</span><b>{Math.round(snapshot.viewport.zoom * 100)}%</b><span>⌘ + scroll to zoom</span><span aria-label="Render evidence">{renderEvidence}</span><span aria-label="Main thread responsiveness">{mainThreadEvidence}</span><span aria-label="Resource evidence">{resourceEvidence}</span></div>
        {error && <div className="engine-error" role="alert">{error}</div>}
      </section>

      <aside className="inspector panel" aria-label="Properties">
        <div className="panel-heading"><span>Inspect</span><span className="revision">r{snapshot.revision}</span></div>
        {selected ? <Inspector node={selected} onUpdate={update} readOnly={!canEdit} /> : <div className="empty-inspector">Select an object to reveal its geometry, fill and layer settings.</div>}
        <div className="history-actions"><button disabled={!canEdit || snapshot.selectedIds.length === 0} onClick={() => command({ type: "duplicate", ids: snapshot.selectedIds })}>Duplicate ⌘D</button><button disabled={!canEdit || !snapshot.canUndo} onClick={() => command({ type: "undo" })}>↶ Undo</button><button disabled={!canEdit || !snapshot.canRedo} onClick={() => command({ type: "redo" })}>Redo ↷</button></div>
      </aside>
    </main>
  );
}

function Inspector({ node, onUpdate, readOnly }: { node: CanvasNode; onUpdate: (patch: Partial<CanvasNode>) => void; readOnly: boolean }) {
  const field = (label: string, key: keyof CanvasNode, value: string | number, unit = "") => <label className="field"><span>{label}</span><div><input aria-label={label} readOnly={readOnly} inputMode={typeof value === "number" ? "decimal" : undefined} value={value} onChange={(event) => {
    if (typeof value !== "number") { onUpdate({ [key]: event.target.value }); return; }
    const raw = event.target.value.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed)) return;
    onUpdate({ [key]: parsed / (key === "opacity" ? 100 : 1) });
  }} /><em>{unit}</em></div></label>;
  const gradientCss = node.fillGradient ? `linear-gradient(${node.fillGradient.stops.map((stop) => `${colorCss(stop.color)} ${Math.round(stop.position * 100)}%`).join(", ")})` : undefined;
  const updateGradient = (gradient: DocumentLinearGradient) => onUpdate({ fillGradient: gradient });
  const createGradient = () => {
    const fillColor = node.fillColor ?? documentColorFromCssHex(node.fill);
    if (fillColor) updateGradient(createDefaultLinearGradient(fillColor));
  };
  const updateGradientColor = (index: number, value: string) => {
    const color = documentColorFromCssHex(value);
    if (!node.fillGradient || !color) return;
    updateGradient({ ...node.fillGradient, stops: node.fillGradient.stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, color: { ...color, alpha: stop.color.alpha } } : stop) });
  };
  const updateGradientPosition = (index: number, value: number) => {
    if (!node.fillGradient) return;
    const lower = index === 0 ? 0 : node.fillGradient.stops[index - 1].position;
    const upper = index === node.fillGradient.stops.length - 1 ? 1 : node.fillGradient.stops[index + 1].position;
    const position = Math.max(lower, Math.min(upper, value));
    updateGradient({ ...node.fillGradient, stops: node.fillGradient.stops.map((stop, stopIndex) => stopIndex === index ? { ...stop, position } : stop) });
  };
  const addGradientStop = () => {
    if (!node.fillGradient || node.fillGradient.stops.length >= 16) return;
    let insertion = 0;
    let largestGap = -1;
    for (let index = 0; index < node.fillGradient.stops.length - 1; index += 1) {
      const gap = node.fillGradient.stops[index + 1].position - node.fillGradient.stops[index].position;
      if (gap > largestGap) { largestGap = gap; insertion = index; }
    }
    if (largestGap <= 0) return;
    const left = node.fillGradient.stops[insertion];
    const nextStop = { position: left.position + largestGap / 2, color: structuredClone(left.color) };
    updateGradient({ ...node.fillGradient, stops: [...node.fillGradient.stops.slice(0, insertion + 1), nextStop, ...node.fillGradient.stops.slice(insertion + 1)] });
  };
  const removeGradientStop = (index: number) => {
    if (!node.fillGradient || node.fillGradient.stops.length <= 2) return;
    updateGradient({ ...node.fillGradient, stops: node.fillGradient.stops.filter((_, stopIndex) => stopIndex !== index) });
  };
  const setGradientDirection = (start: [number, number], end: [number, number]) => node.fillGradient && updateGradient({ ...node.fillGradient, start, end });
  return <div className="inspector-content">
    <div className="selection-title"><span className={`node-icon ${node.kind}`}>{node.kind === "ellipse" ? "○" : node.kind === "text" ? "T" : node.kind === "frame" ? "#" : "□"}</span><input readOnly={readOnly} value={node.name} aria-label="Layer name" onChange={(event) => onUpdate({ name: event.target.value })} /></div>
    <section><h2>Geometry</h2><div className="field-grid">{field("X", "x", node.x)}{field("Y", "y", node.y)}{field("W", "width", Math.round(node.width))}{field("H", "height", Math.round(node.height))}{field("Rotation", "rotation", Math.round(node.rotation), "°")}</div></section>
    {node.kind !== "text" && <section><h2>Appearance</h2>{node.fillGradient ? <div className="gradient-summary"><div className="gradient-preview" style={{ background: gradientCss }} /><div><strong>Linear gradient</strong><span>{node.fillGradient.stops.length} color stops</span></div><div className="gradient-directions" aria-label="Gradient direction"><button type="button" aria-pressed={sameDirection(node.fillGradient, [0, 0], [1, 0])} disabled={readOnly} onClick={() => setGradientDirection([0, 0], [1, 0])}>Horizontal</button><button type="button" aria-pressed={sameDirection(node.fillGradient, [0, 0], [0, 1])} disabled={readOnly} onClick={() => setGradientDirection([0, 0], [0, 1])}>Vertical</button><button type="button" aria-pressed={sameDirection(node.fillGradient, [0, 0], [1, 1])} disabled={readOnly} onClick={() => setGradientDirection([0, 0], [1, 1])}>Diagonal</button></div><div className="gradient-stops">{node.fillGradient.stops.map((stop, index) => <label key={`${stop.position}-${index}`} className="gradient-stop"><span>Stop {index + 1}</span><input aria-label={`Gradient stop ${index + 1} color`} disabled={readOnly} type="color" value={opaqueColorCss(stop.color)} onChange={(event) => updateGradientColor(index, event.target.value)} /><input aria-label={`Gradient stop ${index + 1} position`} disabled={readOnly} type="range" min={index === 0 ? 0 : node.fillGradient!.stops[index - 1].position} max={index === node.fillGradient!.stops.length - 1 ? 1 : node.fillGradient!.stops[index + 1].position} step="0.01" value={stop.position} onChange={(event) => updateGradientPosition(index, Number(event.target.value))} /><em>{Math.round(stop.position * 100)}%</em><button type="button" aria-label={`Remove gradient stop ${index + 1}`} disabled={readOnly || node.fillGradient!.stops.length <= 2} onClick={() => removeGradientStop(index)}>−</button></label>)}</div><button type="button" aria-label="Add gradient stop" disabled={readOnly || node.fillGradient.stops.length >= 16} onClick={addGradientStop}>Add stop</button><button type="button" disabled={readOnly} onClick={() => onUpdate({ fill: node.fill })}>Replace with solid</button></div> : <>{field("Fill", "fill", node.fill)}<div className="color-preview" style={{ background: node.fill }} /><button className="add-gradient-button" type="button" disabled={readOnly} onClick={createGradient}>Add linear gradient</button></>}{field("Stroke", "stroke", node.stroke)}{field("Stroke width", "strokeWidth", node.strokeWidth, "px")}{field("Radius", "radius", node.radius, "px")}{field("Opacity", "opacity", Math.round(node.opacity * 100), "%")}</section>}
    {node.kind === "text" && <section><h2>Content</h2><textarea readOnly={readOnly} value={node.text} onChange={(event) => onUpdate({ text: event.target.value })} aria-label="Text content" /></section>}
    <section><h2>Layer</h2><label className="toggle"><input disabled={readOnly} type="checkbox" checked={node.visible !== false} onChange={(event) => onUpdate({ visible: event.target.checked })} />Visible</label><label className="toggle"><input disabled={readOnly} type="checkbox" checked={Boolean(node.locked)} onChange={(event) => onUpdate({ locked: event.target.checked })} />Lock editing</label></section>
  </div>;
}

function colorCss(color: DocumentColor): string {
  return colorToSrgbCss(color);
}

function opaqueColorCss(color: DocumentColor): string {
  return colorToOpaqueSrgbCss(color);
}

function sameDirection(gradient: DocumentLinearGradient, start: [number, number], end: [number, number]) {
  return gradient.start[0] === start[0] && gradient.start[1] === start[1] && gradient.end[0] === end[0] && gradient.end[1] === end[1];
}
