import type { CanvasNode, DocumentAsset, Viewport } from "./editor-protocol";
import { createRemediationMultiRunGpuTextFixture } from "./remediation-multi-run-gpu-text-fixture";

export type RemediationTrackingGpuTextFixture = {
  format: "makefigma-remediation-tracking-gpu-text-fixture-v1";
  viewport: Viewport;
  assets: Array<DocumentAsset & { bytesBase64?: string; preRegistered?: true }>;
  nodes: CanvasNode[];
};

/** Browser proof that positive and negative PIXELS tracking survive Rust
 * shaping and enter the WebGPU Text Pass as shaped glyph advances. */
export function createRemediationTrackingGpuTextFixture(): RemediationTrackingGpuTextFixture {
  const base = createRemediationMultiRunGpuTextFixture();
  const text = structuredClone(base.nodes[0]!);
  if (!text.textProperties) throw new Error("Tracking fixture text properties are unavailable");
  text.id = "00000000-0000-4000-8000-0000000030c3";
  text.name = "Per-run GPU tracking";
  text.textProperties.runs = text.textProperties.runs.map((run, index) => ({
    ...run,
    letterSpacing: index === 0 ? 2 : -1,
  }));
  return {
    format: "makefigma-remediation-tracking-gpu-text-fixture-v1",
    viewport: structuredClone(base.viewport),
    assets: structuredClone(base.assets),
    nodes: [text],
  };
}
