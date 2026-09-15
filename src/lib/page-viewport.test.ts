import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { fitViewportToBounds, isSameRenderedViewport, pageContentBounds, selectCoveringViewportFrame, selectViewportFrameForInteraction, viewportReprojectionRect } from "./page-viewport";

describe("page viewport", () => {
  const surface = { width: 800, height: 600 };
  const overview = { ...surface, viewport: { x: 0, y: 0, zoom: 1 }, effects: "source" };
  const detail = { ...surface, viewport: { x: 0, y: 0, zoom: 2 }, effects: "complete" };

  it("uses a single covering overview when zooming out from a differently shaded detail frame", () => {
    const result = selectCoveringViewportFrame([detail, overview], { x: 0, y: 0, zoom: 1.5 }, surface);
    expect(result?.frame).toBe(overview);
    expect(result?.rect).toEqual({ x: -200, y: -150, width: 1200, height: 900 });
  });

  it("keeps the latest detailed frame when it covers the zoomed-in view", () => {
    expect(selectCoveringViewportFrame([detail, overview], { x: 0, y: 0, zoom: 3 }, surface)?.frame).toBe(detail);
  });

  it("requires a fresh complete paint when zooming out beyond every cached view", () => {
    expect(selectCoveringViewportFrame([detail, overview], { x: 0, y: 0, zoom: .9 }, surface)).toBeUndefined();
  });

  it("uses the widest cached raster as a temporary interaction preview", () => {
    const result = selectViewportFrameForInteraction([detail, overview], { x: 0, y: 0, zoom: .5 }, surface);
    expect(result?.frame).toBe(overview);
    expect(result?.rect).toEqual({ x: 200, y: 150, width: 400, height: 300 });
    expect(selectViewportFrameForInteraction([], { x: 0, y: 0, zoom: 1 }, surface)).toBeUndefined();
  });

  it("does not splice a partial panned frame over the overview", () => {
    expect(selectCoveringViewportFrame([detail, overview], { x: 30, y: 0, zoom: 2 }, surface)?.frame).toBe(overview);
    expect(selectCoveringViewportFrame([detail, overview], { x: 900, y: 0, zoom: 2 }, surface)).toBeUndefined();
  });

  it("repaints uncovered areas after the surface grows", () => {
    expect(selectCoveringViewportFrame([overview], overview.viewport, { width: 1000, height: 600 })).toBeUndefined();
    expect(selectCoveringViewportFrame([overview], overview.viewport, surface)?.frame).toBe(overview);
  });

  it("requires a new scene preview when zooming out or exposing content by panning", () => {
    const previous = { x: -100, y: 20, zoom: 2 };
    expect(isSameRenderedViewport(previous, { ...previous })).toBe(true);
    expect(isSameRenderedViewport(previous, { ...previous, zoom: .5 })).toBe(false);
    expect(isSameRenderedViewport(previous, { ...previous, x: 100 })).toBe(false);
    expect(isSameRenderedViewport(undefined, previous)).toBe(false);
    const exposed = viewportReprojectionRect(previous, { ...previous, zoom: .5 }, { width: 800, height: 600 }, { width: 800, height: 600 });
    expect(exposed).toEqual({ x: 300, y: 225, width: 200, height: 150 });
  });
  it("centres and fits a large page frame inside the render surface", () => {
    expect(fitViewportToBounds(
      { left: 0, top: 0, right: 2300, bottom: 1296 },
      { width: 692, height: 668 },
    )).toEqual({ x: -1150, y: -648, zoom: 596 / 2300 });
  });

  it("returns a neutral viewport for an empty page", () => {
    expect(fitViewportToBounds(undefined, { width: 692, height: 668 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("uses visible page roots without expanding the fit to nested children", () => {
    const pageId = "page-a";
    const frame = { ...createNode("frame", 100, 200), id: "frame", pageId, width: 800, height: 600 };
    const child = { ...createNode("rectangle", 5_000, 6_000), id: "child", pageId, parentId: frame.id };
    const otherPage = { ...createNode("rectangle", -1_000, -1_000), id: "other", pageId: "page-b" };

    expect(pageContentBounds([frame, child, otherPage], pageId, pageId)).toEqual({
      left: 100,
      top: 200,
      right: 900,
      bottom: 800,
    });
  });

  it("reprojects an existing frame around the surface centre while zooming", () => {
    expect(viewportReprojectionRect(
      { x: 0, y: 0, zoom: 1 },
      { x: 0, y: 0, zoom: 2 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    )).toEqual({ x: -400, y: -300, width: 1600, height: 1200 });
  });

  it("reprojects pan using the worker's translation-before-scale camera", () => {
    expect(viewportReprojectionRect(
      { x: -100, y: 20, zoom: .5 },
      { x: -60, y: -10, zoom: .5 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    )).toEqual({ x: 20, y: -15, width: 800, height: 600 });
  });
});
