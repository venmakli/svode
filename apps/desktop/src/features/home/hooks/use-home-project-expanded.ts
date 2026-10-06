import { useCallback, useState } from "react";

const STORAGE_PREFIX = "svode:home-project-expanded:";

function readExpanded(projectId: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + projectId) === "1";
  } catch {
    return false;
  }
}

/** Whether a project of the Home sidebar is expanded, kept on this device. */
export function useHomeProjectExpanded(
  projectId: string,
): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpandedState] = useState(() => readExpanded(projectId));
  const setExpanded = useCallback(
    (next: boolean) => {
      setExpandedState(next);
      try {
        if (next) window.localStorage.setItem(STORAGE_PREFIX + projectId, "1");
        else window.localStorage.removeItem(STORAGE_PREFIX + projectId);
      } catch {
        // localStorage can be unavailable in restricted WebViews; keep runtime state.
      }
    },
    [projectId],
  );
  return [expanded, setExpanded];
}
