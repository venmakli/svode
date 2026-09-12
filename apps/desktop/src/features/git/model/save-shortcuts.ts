import { shortcutLabel } from "@/shared/lib/shortcut-description";
import {
  saveSelfShortcut,
  saveDescendantsShortcut,
} from "./shortcut-descriptions";

export type GitSaveShortcutScope = "self" | "descendants" | "mixed";

export function gitSaveShortcutLabel(scope: GitSaveShortcutScope): string {
  const self = shortcutLabel(saveSelfShortcut);
  const descendants = shortcutLabel(saveDescendantsShortcut);
  return scope === "self"
    ? self
    : scope === "descendants"
      ? descendants
      : `${self} / ${descendants}`;
}
