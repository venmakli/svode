export interface TerminalSize {
  cols: number;
  rows: number;
}

const waiters = new Map<string, (size: TerminalSize) => void>();

/**
 * Resolves with the size of the first fit of this tab's pane, or the fallback
 * after the timeout, so its PTY starts as wide as the terminal that shows it.
 */
export function waitForPaneSize(
  tabId: string,
  fallback: TerminalSize,
  timeoutMs: number,
): Promise<TerminalSize> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(fallback), timeoutMs);
    function settle(size: TerminalSize) {
      clearTimeout(timer);
      waiters.delete(tabId);
      resolve(size);
    }
    waiters.set(tabId, settle);
  });
}

/** Hands the fitted pane size to a tab waiting to spawn its PTY. */
export function reportPaneSize(tabId: string, size: TerminalSize): void {
  waiters.get(tabId)?.(size);
}
