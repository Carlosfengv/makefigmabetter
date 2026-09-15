import { canvasDesignTokens, canvasFont } from "./canvas-design-tokens";
import type { AutoLayoutPaddingOverlay } from "./auto-layout-padding-overlay";
import type { TransformPoint } from "./scene-transform";

export type AutoLayoutPaddingBadgeBounds = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  label: string;
}>;

export function autoLayoutPaddingBadgeBounds(
  ctx: OffscreenCanvasRenderingContext2D,
  overlay: AutoLayoutPaddingOverlay,
  toScreen: (x: number, y: number) => TransformPoint,
): AutoLayoutPaddingBadgeBounds {
  const polygon = overlay.polygon.map((point) => toScreen(point.x, point.y));
  const center = polygon.reduce((sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }), { x: 0, y: 0 });
  const label = String(Number(overlay.value.toFixed(2)));
  const style = canvasDesignTokens.overlay.autoLayoutPadding;
  ctx.save();
  ctx.font = canvasFont(canvasDesignTokens.typography.measurement);
  const labelWidth = Math.ceil(ctx.measureText(label).width) + style.horizontalInset * 2;
  ctx.restore();
  return {
    left: center.x - labelWidth / 2,
    top: center.y - style.badgeHeight / 2,
    right: center.x + labelWidth / 2,
    bottom: center.y + style.badgeHeight / 2,
    centerX: center.x,
    centerY: center.y,
    label,
  };
}

export function isPointInAutoLayoutPaddingBadge(
  bounds: AutoLayoutPaddingBadgeBounds,
  point: TransformPoint,
): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

export function renderAutoLayoutPadding(
  ctx: OffscreenCanvasRenderingContext2D,
  overlay: AutoLayoutPaddingOverlay,
  toScreen: (x: number, y: number) => TransformPoint,
) {
  const polygon = overlay.polygon.map((point) => toScreen(point.x, point.y));
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const style = canvasDesignTokens.overlay.autoLayoutPadding;
  ctx.save();
  ctx.beginPath();
  polygon.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = canvasDesignTokens.color.selectionFill;
  ctx.fillRect(left, top, right - left, bottom - top);
  ctx.strokeStyle = canvasDesignTokens.color.selection;
  ctx.lineWidth = style.hatchWidth;
  for (let offset = left - (bottom - top); offset <= right + (bottom - top); offset += style.hatchGap) {
    ctx.beginPath();
    ctx.moveTo(offset, bottom);
    ctx.lineTo(offset + (bottom - top), top);
    ctx.stroke();
  }
  ctx.restore();

  const badge = autoLayoutPaddingBadgeBounds(ctx, overlay, toScreen);
  ctx.save();
  ctx.font = canvasFont(canvasDesignTokens.typography.measurement);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = canvasDesignTokens.color.selection;
  ctx.beginPath();
  ctx.roundRect(badge.left, badge.top, badge.right - badge.left, badge.bottom - badge.top, style.cornerRadius);
  ctx.fill();
  ctx.fillStyle = canvasDesignTokens.color.selectionLabelText;
  ctx.fillText(badge.label, badge.centerX, badge.centerY);
  ctx.restore();
}
