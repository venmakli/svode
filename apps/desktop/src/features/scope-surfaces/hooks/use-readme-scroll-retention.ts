import { useLayoutEffect, useRef } from "react";
import type { ScopeSurfaceId } from "../model/types";

export function useReadmeScrollRetention(activeSurfaceId?: ScopeSurfaceId) {
  const hostRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<{ element: HTMLElement; top: number } | null>(
    null,
  );

  function rememberReadmeScroll() {
    let element = hostRef.current?.parentElement;
    while (element) {
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY)) {
        savedScroll.current = { element, top: element.scrollTop };
        return;
      }
      element = element.parentElement;
    }
  }

  useLayoutEffect(() => {
    if (activeSurfaceId !== "readme" || !savedScroll.current) return;
    const { element, top } = savedScroll.current;
    if (element.isConnected) element.scrollTop = top;
  }, [activeSurfaceId]);

  return { hostRef, rememberReadmeScroll };
}
