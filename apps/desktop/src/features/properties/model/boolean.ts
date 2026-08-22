export function effectiveBooleanValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}
