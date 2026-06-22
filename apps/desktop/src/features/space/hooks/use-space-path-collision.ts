import { useEffect, useState } from "react";
import { spacePathExists } from "../api/space-actions";

interface SpacePathCollisionState {
  checking: boolean;
  collision: boolean;
}

export function useSpacePathCollision(
  spacePath: string | null,
): SpacePathCollisionState {
  const [result, setResult] = useState<{
    spacePath: string;
    checking: boolean;
    collision: boolean;
  } | null>(null);

  useEffect(() => {
    if (!spacePath) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const exists = await spacePathExists(spacePath);
        if (!cancelled) {
          setResult({ spacePath, checking: false, collision: exists });
        }
      } catch {
        if (!cancelled) {
          setResult({ spacePath, checking: false, collision: false });
        }
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [spacePath]);

  const current = result?.spacePath === spacePath ? result : null;
  return {
    checking: Boolean(spacePath && (!current || current.checking)),
    collision: Boolean(spacePath && current?.collision),
  };
}
