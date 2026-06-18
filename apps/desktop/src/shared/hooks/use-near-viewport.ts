import * as React from "react";

interface UseNearViewportOptions {
  disabled?: boolean;
  rootMargin?: string;
}

export function useNearViewport<T extends Element>({
  disabled = false,
  rootMargin = "600px",
}: UseNearViewportOptions = {}): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T | null>(null);
  const [nearViewport, setNearViewport] = React.useState(disabled);

  React.useEffect(() => {
    if (disabled) {
      setNearViewport(true);
      return;
    }
    if (nearViewport) return;

    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [disabled, nearViewport, rootMargin]);

  return [ref, nearViewport];
}
