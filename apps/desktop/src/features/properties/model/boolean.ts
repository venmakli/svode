import type { BooleanDisplay } from "./types";

export function effectiveBooleanValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}

export function effectiveBooleanDisplay(
  display: string | null | undefined,
): BooleanDisplay {
  if (display === null || display === undefined || display === "checkbox") {
    return "checkbox";
  }
  if (display === "switch") return "switch";
  throw new Error(`Invalid boolean display: ${display}`);
}
