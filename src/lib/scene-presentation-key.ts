export type ScenePresentationIdentity = Readonly<{
  revision: number;
  pageId: string;
  transientSceneVersion: number;
  resourceGeneration: string | number;
}>;

/** Identifies every input that can change the pixels of a presented scene. */
export function scenePresentationKey(identity: ScenePresentationIdentity): string {
  return JSON.stringify([
    identity.revision,
    identity.pageId,
    identity.transientSceneVersion,
    identity.resourceGeneration,
  ]);
}
