export type GitSaveShortcutScope = "self" | "descendants" | "mixed";

export function gitSaveShortcutLabel(scope: GitSaveShortcutScope): string {
  const mac = isMacPlatform();
  if (scope === "self") return mac ? "⌘S" : "Ctrl+S";
  if (scope === "descendants") return mac ? "⇧⌘S" : "Ctrl+Shift+S";
  return mac ? "⌘S / ⇧⌘S" : "Ctrl+S / Ctrl+Shift+S";
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.platform.toLowerCase().includes("mac") ||
    /macintosh|mac os x/i.test(navigator.userAgent)
  );
}
