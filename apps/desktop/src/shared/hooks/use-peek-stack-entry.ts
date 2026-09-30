import { useEffect, useRef } from "react";
import { pushPeek } from "@/shared/lib/peek-stack";

/** Keeps an open peek on the peek stack, closed from the top by ⌘W. */
export function usePeekStackEntry(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    return pushPeek(() => closeRef.current());
  }, [open]);
}
