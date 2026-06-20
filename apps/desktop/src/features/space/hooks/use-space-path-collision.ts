import { useEffect, useState } from "react";
import { spacePathExists } from "../api/space-actions";

export function useSpacePathCollision(spacePath: string | null): boolean {
  const [result, setResult] = useState<{
    spacePath: string;
    collision: boolean;
  } | null>(null);

  useEffect(() => {
    if (!spacePath) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const exists = await spacePathExists(spacePath);
        if (!cancelled) setResult({ spacePath, collision: exists });
      } catch {
        if (!cancelled) setResult({ spacePath, collision: false });
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [spacePath]);

  return Boolean(spacePath && result?.spacePath === spacePath && result.collision);
}
