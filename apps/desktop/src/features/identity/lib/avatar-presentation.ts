const AVATAR_COLORS = [
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

export function humanAvatar(
  identity?: {
    name?: string | null;
    email?: string | null;
  } | null,
) {
  const emailKey = identity?.email?.trim().toLowerCase() ?? "";
  const name = identity?.name?.trim() ?? "";
  const letter = (name || emailKey).match(/\p{L}/u)?.[0];
  const initials = letter ? Array.from(letter.toUpperCase())[0] : "?";
  const backgroundColor = emailKey
    ? AVATAR_COLORS[hashFnv1a(emailKey) % AVATAR_COLORS.length]
    : NEUTRAL_GRAY;
  const channels = [1, 3, 5].map((offset) => {
    const channel =
      parseInt(backgroundColor.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  const color = luminance > 0.179 ? "#000000" : "#FFFFFF";
  return { initials, style: { backgroundColor, color } };
}
