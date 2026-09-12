export function isMacKeyboardPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (/mac/i.test(navigator.platform) ||
      /macintosh|mac os x/i.test(navigator.userAgent))
  );
}

export function matchesPhysicalShortcut(
  event: KeyboardEvent,
  code: string,
  shift = false,
  mac = isMacKeyboardPlatform(),
): boolean {
  return (
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.getModifierState("AltGraph") &&
    !event.altKey &&
    event.shiftKey === shift &&
    event.metaKey === mac &&
    event.ctrlKey === !mac &&
    event.code === code
  );
}
