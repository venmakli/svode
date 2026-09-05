import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const PAGE_SIZE = 50;

export function useChangesAccordion(
  paths: string[],
  body: RefObject<HTMLDivElement | null>,
  visiblePaths = paths,
) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pageWindow, setPageWindow] = useState({
    generation: visiblePaths.join("\0"),
    count: PAGE_SIZE,
  });
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const generation = visiblePaths.join("\0");
  const count =
    pageWindow.generation === generation ? pageWindow.count : PAGE_SIZE;
  const surviving = expanded.filter((path) => paths.includes(path));
  const shown = visiblePaths.filter(
    (path, index) =>
      index < count || surviving.includes(path) || path === focusedPath,
  );
  const focused = useRef<string | null>(null);
  const previous = useRef(visiblePaths);
  useLayoutEffect(() => {
    const path = focused.current;
    if (path && !visiblePaths.includes(path)) {
      const index = Math.max(0, previous.current.indexOf(path));
      const next = shown[Math.min(index, shown.length - 1)];
      const trigger = [
        ...(body.current?.querySelectorAll<HTMLButtonElement>(
          "[data-changes-item-trigger]",
        ) ?? []),
      ].find((node) => node.dataset.changesItemTrigger === next);
      (trigger ?? body.current)?.focus({ preventScroll: true });
    }
    previous.current = visiblePaths;
    if (expanded.some((path) => !paths.includes(path))) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled)
          setExpanded((current) =>
            current.filter((path) => paths.includes(path)),
          );
      });
      return () => {
        cancelled = true;
      };
    }
  }, [paths, visiblePaths, shown, body, expanded]);
  return {
    shown,
    expanded: surviving.filter((path) => visiblePaths.includes(path)),
    setExpanded: (next: string[]) =>
      setExpanded((current) => [
        ...current.filter((path) => !visiblePaths.includes(path)),
        ...next,
      ]),
    remaining: visiblePaths.length - shown.length,
    more: () => setPageWindow({ generation, count: count + PAGE_SIZE }),
    onFocus: (target: HTMLElement) => {
      focused.current =
        target.closest<HTMLElement>("[data-changes-item]")?.dataset
          .changesItem ?? null;
      setFocusedPath(focused.current);
    },
    onBlur: (target: EventTarget | null) => {
      if (target instanceof Node && !body.current?.contains(target))
        focused.current = null;
    },
  };
}
