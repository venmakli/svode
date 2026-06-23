import { toWebviewAssetUrl } from "@/platform/assets/assets-api";

export function resolveEntryImageSource({
  value,
  spacePath,
  entryPath,
}: {
  value: string;
  spacePath: string;
  entryPath: string;
}) {
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(value)) return value;
  if (value.startsWith("/")) return toWebviewAssetUrl(value);
  if (value.startsWith("./") || value.startsWith("../")) {
    return toWebviewAssetUrl(joinEntryPath(spacePath, entryPath, value));
  }
  return toWebviewAssetUrl(joinSpacePath(spacePath, value));
}

function joinSpacePath(spacePath: string, value: string) {
  const base = spacePath.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return `${base}/${rel}`;
}

function joinEntryPath(spacePath: string, entryPath: string, value: string) {
  const normalizedEntry = entryPath.replace(/\\/g, "/");
  const parent = normalizedEntry.includes("/")
    ? normalizedEntry.slice(0, normalizedEntry.lastIndexOf("/"))
    : "";
  return normalizePath(
    joinSpacePath(spacePath, `${parent}/${value.replace(/\\/g, "/")}`),
  );
}

function normalizePath(path: string) {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}
