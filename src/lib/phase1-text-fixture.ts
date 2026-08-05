import type { CanvasNode } from "./editor-protocol";

/** Validates the durable properties in a text regression fixture before it is
 * handed to the worker's legacy-to-Canonical migration path. */
export function validatePhase1TextFixture(nodes: readonly CanvasNode[]): string[] {
  const errors: string[] = [];
  const encoder = new TextEncoder();
  for (const node of nodes) {
    if (node.kind !== "text") continue;
    const text = node.text ?? "";
    const properties = node.textProperties;
    if (!properties) {
      errors.push(`${node.id}: missing textProperties`);
      continue;
    }
    const byteLength = encoder.encode(text).byteLength;
    const utf8Boundaries = new Set<number>([0]);
    let byteOffset = 0;
    for (const scalar of text) {
      byteOffset += encoder.encode(scalar).byteLength;
      utf8Boundaries.add(byteOffset);
    }
    let expectedStart = 0;
    for (const run of properties.runs) {
      if (
        run.start !== expectedStart
        || run.end <= run.start
        || run.end > byteLength
        || !utf8Boundaries.has(run.start)
        || !utf8Boundaries.has(run.end)
      ) {
        errors.push(`${node.id}: invalid UTF-8 style run ${run.start}-${run.end}`);
        break;
      }
      expectedStart = run.end;
    }
    if (properties.runs.length > 0 && expectedStart !== byteLength) {
      errors.push(`${node.id}: style runs do not cover source bytes`);
    }
  }
  return errors;
}
