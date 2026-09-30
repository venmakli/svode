import { useEffect, useState } from "react";
import { describeNavigationItem } from "../api/navigation";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationResolvedItem,
} from "../model/keys";
import { useNavigationState } from "./use-navigation-state";

interface Described {
  id: string;
  item: NavigationResolvedItem | null;
}

/**
 * An artifact or Space resolved against its source without recording it:
 * its current title, icon and form. Until Desktop answers, the given item is
 * shown; null once the source shows the object is gone. It is resolved again
 * whenever the navigation state is.
 */
export function useDescribedNavigationItem(
  item: NavigationItem | null,
): NavigationResolvedItem | null {
  const projectPath = useNavigationState((state) => state.projectPath);
  const revision = useNavigationState((state) => state.revision);
  const [described, setDescribed] = useState<Described | null>(null);
  const id = item ? navigationKeyId(item.key) : null;
  // The latest item of this identity; a new identity is described afresh.
  const [latest, setLatest] = useState(item);
  if (
    item !== latest &&
    (item === null || latest === null || id !== navigationKeyId(latest.key))
  ) {
    setLatest(item);
  }

  useEffect(() => {
    if (!projectPath || !latest) return;
    let cancelled = false;
    const requested = navigationKeyId(latest.key);
    describeNavigationItem(projectPath, latest).then(
      (result) => {
        if (!cancelled) setDescribed({ id: requested, item: result });
      },
      (error: unknown) => {
        console.error("Failed to resolve the main area object:", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [latest, projectPath, revision]);

  if (!item || !id) return null;
  return described?.id === id ? described.item : item;
}
