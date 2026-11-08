/**
 * Esc events a layer prevented only to stay open. A Radix layer prevents the
 * default of every Esc it does not close on, before React handlers run, so
 * content below tells such an Esc from one a menu or dialog already took.
 */
const keptOpen = new WeakSet<Event>();

/** Keeps a layer open on Esc while the key still belongs to its target. */
export function keepLayerOpenOnEscape(event: KeyboardEvent) {
  event.preventDefault();
  keptOpen.add(event);
}

/**
 * Whether Esc in `target` cancels an inline edit: a text field inside an
 * element marked `data-escape-cancels-edit`. The edit takes that Esc and lets
 * the focus go, so a layer around it stays open and the next Esc closes it.
 */
export function cancelsEditOnEscape(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return (
    (element.tagName === "INPUT" || element.tagName === "TEXTAREA") &&
    element.closest("[data-escape-cancels-edit]") !== null
  );
}

/** Whether something already took this Esc, e.g. a closing menu. */
export function isEscapeTaken(event: KeyboardEvent) {
  return event.defaultPrevented && !keptOpen.has(event);
}

/** Takes the Esc so handlers further out leave it. */
export function takeEscape(event: KeyboardEvent) {
  event.preventDefault();
  keptOpen.delete(event);
}
