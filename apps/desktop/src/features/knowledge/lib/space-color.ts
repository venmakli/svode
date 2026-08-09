const SPACE_COLORS = [
  "#65a30d",
  "#2563eb",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#db2777",
];

export function knowledgeSpaceColor(spaceId: string | null) {
  let hash = 0;
  for (const character of spaceId ?? "root") {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return SPACE_COLORS[hash % SPACE_COLORS.length];
}
