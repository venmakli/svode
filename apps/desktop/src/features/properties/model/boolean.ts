import type { BooleanDisplay } from "./types";

export function effectiveBooleanValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}

/** A display of a newer Svode version is drawn as the default checkbox. */
export function effectiveBooleanDisplay(
  display: string | null | undefined,
): BooleanDisplay {
  return display === "switch" ? "switch" : "checkbox";
}
