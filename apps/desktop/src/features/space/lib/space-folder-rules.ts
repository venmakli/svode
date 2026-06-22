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
    .replace(/[^a-z0-9-]/g, "");
}

export function sanitizeFolder(value: string): string {
  return value.replace(/[^a-z0-9-]/g, "").replace(/^[-.]/, "");
}

export function isCloneUrlValid(trimmedUrl: string): boolean {
  return CLONE_URL_REGEX.test(trimmedUrl);
}
