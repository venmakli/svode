export function humanizeOwnerPath(path: string) {
  const segment = path === "." ? "" : (path.split("/").pop() ?? path);
  return segment.replace(/[-_]+/g, " ").trim() || "README";
}

export function isReadmeMissingError(error: unknown, path: string) {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes(path.toLowerCase()) &&
    (normalizedMessage.includes("file not found") ||
      normalizedMessage.includes("no such file") ||
      normalizedMessage.includes("не найден"))
  );
}
