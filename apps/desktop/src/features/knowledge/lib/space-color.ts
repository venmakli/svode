const SPACE_COLORS = [
  "#7c3aed",
  "#0891b2",
  "#ea580c",
  "#16a34a",
  "#db2777",
  "#2563eb",
  "#ca8a04",
  "#0f766e",
];

const ROOT_SPACE_KEY = "\u0000root";

export function knowledgeSpaceColorMap(spaceIds: Array<string | null>) {
  const colors = new Map<string, string>();
  for (const spaceId of spaceIds) {
    const key = knowledgeSpaceColorKey(spaceId);
    if (!colors.has(key)) {
      colors.set(key, SPACE_COLORS[colors.size % SPACE_COLORS.length]);
    }
  }
  return colors;
}

export function knowledgeSpaceColorKey(spaceId: string | null) {
  return spaceId ?? ROOT_SPACE_KEY;
}
