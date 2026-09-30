import { useEffect, useState } from "react";

/** Whether the pointer or the focus is inside the element. */
export function useInteractionWithin(element: HTMLElement | null): boolean {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (!element) return;
    const enter = () => setPointer(true);
    const leave = () => setPointer(false);
    const focusIn = () => setFocus(true);
    const focusOut = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null)) {
        setFocus(false);
      }
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", focusIn);
    element.addEventListener("focusout", focusOut);
    return () => {
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", focusIn);
      element.removeEventListener("focusout", focusOut);
      setPointer(false);
      setFocus(false);
    };
  }, [element]);

  return pointer || focus;
}
