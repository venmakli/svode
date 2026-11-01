import { toWebviewAssetUrl } from "@/platform/assets/assets-api";

export function resolveItemImageSource({
  value,
  spacePath,
  itemPath,
}: {
  value: string;
  spacePath: string;
  itemPath: string;
}) {
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(value)) return value;
  if (value.startsWith("/")) return toWebviewAssetUrl(normalizePath(value));
  if (value.startsWith("./") || value.startsWith("../")) {
    return toWebviewAssetUrl(joinItemPath(spacePath, itemPath, value));
  }
  return toWebviewAssetUrl(joinSpacePath(spacePath, value));
}

export function resolveSpaceRelativeImageSource({
  value,
  spacePath,
}: {
  value: string;
  spacePath: string;
}) {
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(value)) return value;
  return toWebviewAssetUrl(spaceRelativeImageAbsPath(spacePath, value));
}

export function spaceRelativeImageAbsPath(spacePath: string, value: string) {
  if (value.startsWith("/")) return normalizePath(value);
  return joinSpacePath(spacePath, value);
}

function joinSpacePath(spacePath: string, value: string) {
  const base = spacePath.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalizePath(`${base}/${rel}`);
}

function joinItemPath(spacePath: string, itemPath: string, value: string) {
  const normalizedItem = itemPath.replace(/\\/g, "/");
  const parent = normalizedItem.includes("/")
    ? normalizedItem.slice(0, normalizedItem.lastIndexOf("/"))
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
