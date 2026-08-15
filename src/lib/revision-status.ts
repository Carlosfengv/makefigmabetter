/** An async result may only announce itself while it still describes the live document. */
export function statusRevisionIsCurrent(expectedRevision: number, currentRevision: number) {
  return expectedRevision === currentRevision;
}
