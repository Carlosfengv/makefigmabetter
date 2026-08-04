# Canvas design tokens

`src/lib/canvas-design-tokens.ts` owns visual tokens used by the OffscreenCanvas renderer. It mirrors the role CSS custom properties play for DOM UI, while remaining available inside the Engine Worker.

## Token groups

- `color`: canvas backdrop, grid, layer-name, selection, marquee and label colours.
- `typography`: layer-name, document text and selection-label font treatments.
- `stroke`: line widths, dash patterns and pixel alignment for selection, hover, marquee and grid.
- `overlay`: geometry for Frame names and the selection dimensions label.

## Boundaries

Document-owned layer values—fill, stroke, corner radius, opacity and text content—remain on `CanvasNode`. They are editable content rather than shared UI styling and must not be replaced with global tokens.

When adding or changing Canvas chrome, add a semantic token first and consume it in `editor.worker.ts`. Keep DOM panel tokens in `src/app/globals.css` until a shared, cross-surface token contract is needed.
