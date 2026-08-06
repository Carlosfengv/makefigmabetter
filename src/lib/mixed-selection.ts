/** A UI-facing value that never mistakes an inconsistent selection for a
 * writable concrete value. `mixed` must be replaced by an explicit user edit.
 */
export type MixedSelectionValue<T> =
  | Readonly<{ kind: "same"; value: T }>
  | Readonly<{ kind: "mixed" }>;

export function mixedSelectionValue<T>(values: readonly T[]): MixedSelectionValue<T> {
  const first = values[0];
  if (values.length === 0 || values.some((value) => !Object.is(value, first))) return { kind: "mixed" };
  return { kind: "same", value: first };
}
