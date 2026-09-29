import { useCallback, useState } from "react";

const STORAGE_PREFIX = "svode:sidebar-group-collapsed:";

function readCollapsed(id: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

/** Open state of a sidebar group, kept on this device. */
export function useSidebarGroupOpen(
  id: string,
): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => !readCollapsed(id));
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      try {
        if (next) window.localStorage.removeItem(STORAGE_PREFIX + id);
        else window.localStorage.setItem(STORAGE_PREFIX + id, "1");
      } catch {
        // localStorage can be unavailable in restricted WebViews; keep runtime state.
      }
    },
    [id],
  );
  return [open, setOpen];
}
