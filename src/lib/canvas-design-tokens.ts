 /**
 * Canvas-only visual tokens. They live in TypeScript because the renderer runs
 * in an OffscreenCanvas Worker and cannot consume CSS custom properties.
 */
export const canvasDesignTokens = {
  color: {
    backdrop: "#eeeee8",
    grid: "rgba(45, 48, 37, 0.075)",
    selection: "#0048FF",
    selectionFill: "rgba(0, 72, 255, 0.10)",
    selectionLabelText: "#ffffff",
    measurement: "#f24822",
    measurementFill: "rgba(242, 72, 34, 0.10)",
    layerName: "rgba(35, 37, 31, 0.6)",
  },
  typography: {
    layerName: { family: 'Inter, "Helvetica Neue", sans-serif', weight: 400, size: 12 },
    canvasText: { family: 'Inter, "Avenir Next", "Helvetica Neue", sans-serif', weight: 500 },
    selectionLabel: { family: 'Inter, "Avenir Next", "Helvetica Neue", sans-serif', weight: 500, size: 12 },
    measurement: { family: 'Inter, "Helvetica Neue", sans-serif', weight: 400, size: 11 },
  },
  stroke: {
    grid: { width: 1 },
    selection: { width: 1, dash: [], pixelInset: 0.5 },
    hover: { width: 1, pixelInset: 0.5 },
    marquee: { width: 1, dash: [4, 3] },
    parentRelationship: { width: 1, dash: [4, 3] },
  },
  overlay: {
    frameName: { offsetY: 4, height: 13 },
    selectionLabel: { height: 20, horizontalInset: 7, cornerRadius: 3, offsetY: 2 },
    selectionHandle: { side: 8, hitRadius: 10 },
    measurement: { height: 16, horizontalInset: 4, cornerRadius: 2, offset: 3, capSize: 3 },
    autoLayoutPadding: { hatchGap: 6, hatchWidth: 1, badgeHeight: 16, horizontalInset: 4, cornerRadius: 2 },
  },
} as const;

type CanvasFontToken = { family: string; weight: number; size: number };

export function canvasFont({ family, weight, size }: CanvasFontToken): string {
  return `${weight} ${size}px ${family}`;
}
