import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";

/** Compile-only M1 public-surface probe. It keeps our facade's P0 calls aligned
 * with the locked Plugin API vocabulary while leaving commitAsync visibly in
 * the project-extension namespace. */
export function assertRuntimePublicContract(runtime: FigmaCompatibleRuntime): {
  rootId: string;
  nodeLookup: Promise<unknown>;
  acceptedRevision: Promise<number>;
} {
  const rectangle = runtime.createRectangle();
  rectangle.x = rectangle.x;
  rectangle.y = rectangle.y;
  rectangle.name = rectangle.name;
  rectangle.opacity = rectangle.opacity;
  rectangle.resize(rectangle.width, rectangle.height);
  runtime.currentPage.appendChild(rectangle);
  return {
    rootId: runtime.root.id,
    nodeLookup: runtime.getNodeByIdAsync(rectangle.id),
    acceptedRevision: runtime.commitAsync(),
  };
}
