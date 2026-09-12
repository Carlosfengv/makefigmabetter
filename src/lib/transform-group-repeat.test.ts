import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { affineScreenMatrix, affineSvgMatrix, canMaterializeTransformGroupRepeat, transformGroupRepeatMatrices } from "./transform-group-repeat";
import { exportPageToSvg } from "./svg-export";

const pageId = "00000000-0000-4000-8000-00000000e001";

function group() {
  return {
    ...createNode("transformGroup", 20, 30), id: "00000000-0000-4000-8000-00000000e002", pageId, width: 100, height: 80,
    transformModifiers: [{ type: "REPEAT" as const, count: 2, unitType: "RELATIVE" as const, offset: 1.5, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }],
  };
}

describe("M6 TransformGroup Repeat", () => {
  it("derives bounded linear copies in the group-local basis", () => {
    const source = group();
    expect(canMaterializeTransformGroupRepeat(source)).toBe(true);
    const matrices = transformGroupRepeatMatrices([source], source)!;
    expect(matrices).toHaveLength(2);
    expect(affineSvgMatrix(matrices[0]!, String)).toBe("matrix(1 0 0 1 150 0)");
    expect(affineSvgMatrix(matrices[1]!, String)).toBe("matrix(1 0 0 1 300 0)");
    expect(affineScreenMatrix({ a: 0, b: 1, c: -1, d: 0, e: 20, f: 10 }, { x: 200, y: 100 }, 2)).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 340, f: -80 });
    expect(canMaterializeTransformGroupRepeat({ ...source, transformModifiers: [{ ...source.transformModifiers![0]!, repeatType: "RADIAL" as const }] })).toBe(false);
  });

  it("exports each supported derived subtree without a special-node fallback", () => {
    const parent = group();
    const child = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-00000000e003", pageId, parentId: parent.id, width: 40, height: 20, fill: "#f97316" };
    const result = exportPageToSvg([parent, child], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<path /gu)).toHaveLength(6);
    expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
    expect(result.compatibilityFallbacks.filter((fallback) => fallback.nodeId === parent.id && fallback.capability === "special-node")).toEqual([]);
  });
});
