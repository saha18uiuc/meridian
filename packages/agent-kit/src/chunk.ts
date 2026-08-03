/**
 * Bounded parallelism for workflow code.
 *
 * `p-limit` is banned inside the workflow bundle because its scheduling depends on promise
 * resolution order, which replay does not reproduce. Chunking is the deterministic substitute:
 * the caller passes an already-sorted array, `chunk` splits it the same way every time, and the
 * workflow awaits one group at a time.
 *
 * This function deliberately does not sort. Sorting here would hide the ordering decision from the
 * caller, and the ordering is exactly what makes `sequence_no` assignment reproducible.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, received ${String(size)}`);
  }
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
