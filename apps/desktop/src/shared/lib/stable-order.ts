/**
 * `next` in the order of `previous` for ids both contain, followed by the new
 * ids in their `next` order. Ids gone from `next` are dropped.
 */
export function holdOrder(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const present = new Set(next);
  const kept = previous.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...next.filter((id) => !known.has(id))];
}
