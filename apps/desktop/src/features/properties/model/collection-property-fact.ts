import type { LucideIcon } from "lucide-react";

/**
 * A read-only fact of one item that is not a property of its Collection:
 * it never becomes a column, filter or sort.
 */
export interface CollectionPropertyFact {
  key: string;
  label: string;
  /** Overrides the icon of the value kind. */
  icon?: LucideIcon;
  value: CollectionPropertyFactValue;
}

export type CollectionPropertyFactValue =
  | { kind: "text"; text: string | null }
  /** Values shown as chips. */
  | { kind: "list"; items: readonly string[] }
  /** A file or folder path, shown in full. */
  | { kind: "path"; path: string | null }
  /** A command or other code, shown in full in monospace. */
  | { kind: "code"; code: string | null }
  | { kind: "link"; label: string; onSelect(): void };

/** Facts of one source under its label, such as "From SKILL.md". */
export interface CollectionPropertyFactGroup {
  key: string;
  label: string;
  facts: readonly CollectionPropertyFact[];
}

export function isEmptyCollectionPropertyFact(
  fact: CollectionPropertyFact,
): boolean {
  const { value } = fact;
  if (value.kind === "text") return !value.text?.trim();
  if (value.kind === "list") return value.items.length === 0;
  if (value.kind === "path") return !value.path?.trim();
  if (value.kind === "code") return !value.code?.trim();
  return false;
}
