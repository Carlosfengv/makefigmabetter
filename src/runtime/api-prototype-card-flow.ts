import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import type { RuntimeContainerNodeProxy } from "./container-node-proxy";
import type { RuntimeNodeProxy } from "./node-proxy";

/**
 * The fixed M0–M4 acceptance fixture described in the implementation plan.
 * It intentionally uses only the public Runtime facade: every persistent
 * change still crosses RuntimeSession's PendingProjection → Ack fence.
 */
export type ApiPrototypeCardFlow = Readonly<{
  listFrame: RuntimeContainerNodeProxy;
  detailFrame: RuntimeContainerNodeProxy;
  overlayFrame: RuntimeContainerNodeProxy;
  detailButton: RuntimeNodeProxy;
  overlayButton: RuntimeNodeProxy;
  overlayCloseButton: RuntimeNodeProxy;
  backButton: RuntimeNodeProxy;
}>;

export async function createApiPrototypeCardFlow(runtime: FigmaCompatibleRuntime): Promise<ApiPrototypeCardFlow> {
  const listFrame = runtime.createFrame();
  listFrame.name = "api-prototype-card-flow:list";
  listFrame.resize(360, 640);
  listFrame.layoutMode = "VERTICAL";
  listFrame.paddingTop = 24;
  listFrame.paddingRight = 24;
  listFrame.paddingBottom = 24;
  listFrame.paddingLeft = 24;
  listFrame.itemSpacing = 16;

  const card = runtime.createFrame();
  card.name = "Card";
  card.resize(312, 180);
  card.layoutMode = "VERTICAL";
  card.paddingTop = 16;
  card.paddingRight = 16;
  card.paddingBottom = 16;
  card.paddingLeft = 16;
  card.itemSpacing = 8;
  const image = runtime.createRectangle();
  image.name = "Card image";
  image.resize(280, 72);
  const title = runtime.createText();
  title.name = "Card title";
  const description = runtime.createText();
  description.name = "Card description";
  const detailButton = runtime.createRectangle();
  detailButton.name = "Open details";
  detailButton.resize(120, 40);
  card.appendChild(image);
  card.appendChild(title);
  card.appendChild(description);
  card.appendChild(detailButton);
  listFrame.appendChild(card);

  const detailFrame = runtime.createFrame();
  detailFrame.name = "api-prototype-card-flow:detail";
  detailFrame.x = 400;
  detailFrame.resize(360, 640);
  const overlayButton = runtime.createRectangle();
  overlayButton.name = "Open overlay";
  overlayButton.resize(140, 40);
  const backButton = runtime.createRectangle();
  backButton.name = "Back";
  backButton.resize(100, 40);
  detailFrame.appendChild(overlayButton);
  detailFrame.appendChild(backButton);

  const overlayFrame = runtime.createFrame();
  overlayFrame.name = "api-prototype-card-flow:overlay";
  overlayFrame.resize(240, 160);
  const overlayCloseButton = runtime.createRectangle();
  overlayCloseButton.name = "Close overlay";
  overlayCloseButton.resize(100, 40);
  overlayFrame.appendChild(overlayCloseButton);

  // Read-your-writes is part of the fixture, not merely a post-commit check.
  if (listFrame.children[0] !== card || card.children.map((node) => node.id).join(",") !== [image, title, description, detailButton].map((node) => node.id).join(",") || detailButton.parent !== card) {
    throw new Error("api-prototype-card-flow lost PendingProjection hierarchy.");
  }
  await runtime.commitAsync();

  await listFrame.setPrototypeMetadataAsync({ startingPoint: true });
  await overlayFrame.setPrototypeMetadataAsync({ overlay: { positionType: "CENTER", backgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" } });
  await detailButton.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: detailFrame.id, transition: { type: "DISSOLVE", duration: 120 } }] }]);
  await overlayButton.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "OVERLAY", destinationId: overlayFrame.id, transition: { type: "DIRECTIONAL", direction: "DOWN", duration: 80 } }] }]);
  await overlayCloseButton.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CLOSE" }] }]);
  await backButton.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }]);

  return { listFrame, detailFrame, overlayFrame, detailButton, overlayButton, overlayCloseButton, backButton };
}
