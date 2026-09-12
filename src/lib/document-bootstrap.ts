import type { CanvasPage } from "./editor-protocol";
import type { CoreProjectionNode } from "./transaction-batch";

export const DEFAULT_PAGE_ID = "00000000-0000-0000-0000-000000000001";

const LEGACY_STARTER_LAYERS = new Map<string, readonly [string, string]>([
  ["00000000-0000-4000-8000-000000000001", ["Product card", "frame"]],
  ["00000000-0000-4000-8000-000000000002", ["Sun disc", "ellipse"]],
  ["00000000-0000-4000-8000-000000000003", ["Signal", "rectangle"]],
  ["00000000-0000-4000-8000-000000000004", ["Headline", "text"]],
]);

type BootstrapSnapshot = {
  schemaVersion: number;
  documentId?: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  canonicalHash?: string;
  pages?: CanvasPage[];
  nodes: CoreProjectionNode[];
  retiredIds?: string[];
  [key: string]: unknown;
};

export type BootstrapPageMigration = {
  snapshot: BootstrapSnapshot;
  replacedPageId: string;
  removedStarterNodeIds: string[];
};

/**
 * Old editor builds created every document with a visible demo Page 1 before
 * Figma data arrived. When that page is still empty or byte-for-byte identifiable
 * as the untouched four-layer demo, adopt the first imported Figma page as the
 * canonical default page instead. User-authored Page 1 content is never touched.
 */
export function migrateLegacyFigmaBootstrapPage(
  snapshot: BootstrapSnapshot,
): BootstrapPageMigration | undefined {
  const pages = snapshot.pages ?? [];
  const defaultPage = pages.find((page) => page.id === DEFAULT_PAGE_ID);
  const importedPages = pages
    .filter((page) => page.id !== DEFAULT_PAGE_ID)
    .sort(
      (left, right) =>
        left.positionId.localeCompare(right.positionId) ||
        left.id.localeCompare(right.id),
    );
  if (!defaultPage || !importedPages.length) return undefined;

  const defaultNodes = snapshot.nodes.filter(
    (node) => (node.pageId ?? DEFAULT_PAGE_ID) === DEFAULT_PAGE_ID,
  );
  const untouchedStarter =
    defaultNodes.length === LEGACY_STARTER_LAYERS.size &&
    defaultNodes.every((node) => {
      const expected = LEGACY_STARTER_LAYERS.get(node.id);
      return expected?.[0] === node.name && expected[1] === node.kind;
    });
  if (defaultNodes.length > 0 && !untouchedStarter) return undefined;

  const nonDefaultNodes = snapshot.nodes.filter(
    (node) => (node.pageId ?? DEFAULT_PAGE_ID) !== DEFAULT_PAGE_ID,
  );
  if (!nonDefaultNodes.some(isFigmaImportedNode)) return undefined;

  const adoptedPage = importedPages[0]!;
  const removedStarterNodeIds = defaultNodes.map((node) => node.id);
  const retiredIds = new Set(snapshot.retiredIds ?? []);
  removedStarterNodeIds.forEach((id) => retiredIds.add(id));
  const migratedNodes = snapshot.nodes
    .filter((node) => !removedStarterNodeIds.includes(node.id))
    .map((node) =>
      node.pageId === adoptedPage.id
        ? { ...node, pageId: DEFAULT_PAGE_ID }
        : node,
    );

  return {
    replacedPageId: adoptedPage.id,
    removedStarterNodeIds,
    snapshot: {
      ...structuredClone(snapshot),
      // The source snapshot hash describes the pre-migration document. Rust
      // recomputes the authoritative hash after validating this projection.
      canonicalHash: "",
      pages: pages.map((page) =>
        page.id === DEFAULT_PAGE_ID
          ? {
              id: DEFAULT_PAGE_ID,
              name: adoptedPage.name,
              positionId: adoptedPage.positionId,
            }
          : page,
      ).filter((page) => page.id !== adoptedPage.id),
      // Snapshot hydration validates parents as each node is admitted. Core's
      // paint-order projection may place a child before its parent, so restore
      // a stable parents-first order before handing the migration back to Rust.
      nodes: parentsFirst(migratedNodes),
      retiredIds: [...retiredIds],
    },
  };
}

function isFigmaImportedNode(node: CoreProjectionNode) {
  return Boolean(node.extensions?.["figma.rest.source-id.v1"]);
}

function parentsFirst(nodes: CoreProjectionNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const ordered: CoreProjectionNode[] = [];
  const visit = (node: CoreProjectionNode) => {
    if (emitted.has(node.id)) return;
    if (visiting.has(node.id)) return;
    visiting.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) visit(parent);
    visiting.delete(node.id);
    emitted.add(node.id);
    ordered.push(node);
  };
  nodes.forEach(visit);
  return ordered;
}
