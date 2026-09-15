import { canvasDesignTokens, canvasFont } from "./canvas-design-tokens";
import type { SelectionParentRelationship } from "./selection-parent-relationship";
import type { TransformPoint } from "./scene-transform";

/** All decoration sizes are screen pixels, independent of canvas zoom and
 * ancestor scale. Labels remain upright even inside a rotated frame. */
export function renderParentRelationship(
  ctx: OffscreenCanvasRenderingContext2D,
  relationship: SelectionParentRelationship,
  toScreen: (x: number, y: number) => TransformPoint,
) {
  const screen = (point: TransformPoint) => toScreen(point.x, point.y);
  ctx.save();
  ctx.lineWidth = canvasDesignTokens.stroke.parentRelationship.width;
  if (relationship.autoLayout) {
    const corners = relationship.outline.map(screen);
    ctx.strokeStyle = canvasDesignTokens.color.selection;
    ctx.setLineDash([...canvasDesignTokens.stroke.parentRelationship.dash]);
    ctx.beginPath();
    corners.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = canvasDesignTokens.color.measurement;
  ctx.font = canvasFont(canvasDesignTokens.typography.measurement);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const style = canvasDesignTokens.overlay.measurement;
  for (const distance of relationship.distances) {
    const start = screen(distance.start);
    const end = screen(distance.end);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < 1) continue;
    const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    for (const point of [start, end]) {
      ctx.moveTo(point.x - normal.x * style.capSize, point.y - normal.y * style.capSize);
      ctx.lineTo(point.x + normal.x * style.capSize, point.y + normal.y * style.capSize);
    }
    ctx.stroke();
    const label = String(Number(distance.value.toFixed(2)));
    const labelWidth = Math.ceil(ctx.measureText(label).width) + style.horizontalInset * 2;
    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
    const centerX = (start.x + end.x) / 2 + (horizontal ? 0 : labelWidth / 2 + style.offset);
    const centerY = (start.y + end.y) / 2 - (horizontal ? style.height / 2 + style.offset : 0);
    ctx.fillStyle = canvasDesignTokens.color.measurement;
    ctx.beginPath();
    ctx.roundRect(centerX - labelWidth / 2, centerY - style.height / 2, labelWidth, style.height, style.cornerRadius);
    ctx.fill();
    ctx.fillStyle = canvasDesignTokens.color.selectionLabelText;
    ctx.fillText(label, centerX, centerY);
  }
  ctx.restore();
}
