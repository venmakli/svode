export type CreateSpaceTab = "create" | "clone";

const CYRILLIC_MAP: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const CLONE_URL_REGEX = /^(https?:\/\/)\S+|^[\w.-]+@[\w.-]+:\S+$/;
const FOLDER_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const WINDOWS_DRIVE_PREFIX_REGEX = /^[A-Za-z]:/;

export function slugPreview(name: string): string {
  const transliterated = name
    .toLowerCase()
    .split("")
    .map((c) => CYRILLIC_MAP[c] ?? c)
    .join("");
  return transliterated
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function folderFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const lastSegment = trimmed.split("/").pop() ?? "";
  return lastSegment
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

export function normalizeFolderNameInput(value: string): string {
  return value.trim();
}

export function resolveFolderName(value: string): string | null {
  const normalized = normalizeFolderNameInput(value);
  if (!normalized) return null;
  if (normalized.startsWith("/") || WINDOWS_DRIVE_PREFIX_REGEX.test(normalized)) {
    return null;
  }

  if (
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".." ||
    !FOLDER_NAME_REGEX.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

export function isCloneUrlValid(trimmedUrl: string): boolean {
  return CLONE_URL_REGEX.test(trimmedUrl);
}
