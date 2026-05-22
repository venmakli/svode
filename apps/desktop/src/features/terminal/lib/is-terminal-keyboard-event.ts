export function isTerminalKeyboardEvent(event: KeyboardEvent) {
  const target = event.target;
  return target instanceof HTMLElement && target.closest(".xterm") !== null;
}
