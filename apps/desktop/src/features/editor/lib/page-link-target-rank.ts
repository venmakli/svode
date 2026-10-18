/**
 * Page name key, as `display_name_key` in svode-core: NFKC, case folding and
 * collapsed whitespace. Upper-then-lower casing stands in for full case
 * folding (`ß` → `ss`, `ς` → `σ`), which JavaScript has no API for.
 */
export function pageNameKey(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export const PAGE_LINK_NO_MATCH = 4;

/**
 * Match level of a link target for a query key, more exact first: equal
 * title, title prefix, text inside the title, text inside the path only.
 */
export function pageLinkMatchLevel(
  target: { title: string; path: string },
  queryKey: string,
): number {
  const title = pageNameKey(target.title);
  if (title === queryKey) return 0;
  if (title.startsWith(queryKey)) return 1;
  if (title.includes(queryKey)) return 2;
  if (pageNameKey(target.path).includes(queryKey)) return 3;
  return PAGE_LINK_NO_MATCH;
}

/**
 * Orders targets by match level, keeping their order within a level. Targets
 * the index found by something other than title or path stay, after the rest.
 */
export function rankPageLinkTargets<T extends { title: string; path: string }>(
  targets: T[],
  queryKey: string,
): T[] {
  if (queryKey.length === 0) return targets;
  return targets
    .map((target) => ({ target, level: pageLinkMatchLevel(target, queryKey) }))
    .sort((a, b) => a.level - b.level)
    .map(({ target }) => target);
}
