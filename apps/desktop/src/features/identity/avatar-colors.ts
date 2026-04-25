export const AVATAR_COLORS = [
  "#3B82F6",
  "#EF4444",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
  "#6366F1",
  "#14B8A6",
];

const NEUTRAL_GRAY = "#9CA3AF";

function hashFnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function avatarColorFromEmail(email: string | undefined | null): string {
  if (!email) return NEUTRAL_GRAY;
  return AVATAR_COLORS[hashFnv1a(email) % AVATAR_COLORS.length];
}
