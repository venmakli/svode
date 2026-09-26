// Ctrl+` on every platform, matched by physical key so layouts without a
// backquote character still toggle the terminal.
export function isTerminalToggleShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    event.code === "Backquote"
  );
}
