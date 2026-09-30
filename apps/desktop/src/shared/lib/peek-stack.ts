/**
 * Open peeks in the order they opened; the last one is on top. A peek asks
 * to close the same way its own close button does, guards included.
 */
const stack: { close: () => void }[] = [];

/** Registers an open peek; the returned function removes it. */
export function pushPeek(close: () => void): () => void {
  const entry = { close };
  stack.push(entry);
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Asks the top open peek to close. Returns whether a peek was open. */
export function closeTopPeek(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  top.close();
  return true;
}
