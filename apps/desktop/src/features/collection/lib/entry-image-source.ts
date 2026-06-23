import { convertFileSrc } from "@/platform/native/invoke";

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
  if (value.startsWith("/")) return convertFileSrc(value);
  if (value.startsWith("./") || value.startsWith("../")) {
    return convertFileSrc(joinEntryPath(spacePath, entryPath, value));
  }
  return convertFileSrc(joinSpacePath(spacePath, value));
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
