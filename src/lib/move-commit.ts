/**
 * A pointer-down on a selected layer starts a potential move. It becomes a
 * document mutation only after the snapped world position differs from the
 * position captured at pointer-down.
 */
export function hasCommittedMove(
  initialPositions: ReadonlyMap<string, Readonly<{ x: number; y: number }>>,
  updates: readonly Readonly<{ id: string; x: number; y: number }>[],
): boolean {
  return updates.some((update) => {
    const initial = initialPositions.get(update.id);
    return Boolean(initial && (initial.x !== update.x || initial.y !== update.y));
  });
}
