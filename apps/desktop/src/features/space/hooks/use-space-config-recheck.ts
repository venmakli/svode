import { useEffect, useRef } from "react";
import { useGitStore } from "@/features/git";
import { selectHasUnreadableConfig, useSpaceStore } from "../model/space-store";

/**
 * While the config of the active project or of one of its spaces cannot be
 * read, it is read again on window focus and after a Git status change, such
 * as a conflict resolved in Svode.
 */
export function useSpaceConfigRecheck() {
  const unreadable = useSpaceStore(selectHasUnreadableConfig);
  const statuses = useGitStore((state) => state.statuses);
  const seenStatusesRef = useRef(statuses);

  useEffect(() => {
    if (!unreadable) return;
    const recheck = () => void useSpaceStore.getState().recheckSpaceConfigs();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [unreadable]);

  useEffect(() => {
    if (seenStatusesRef.current === statuses) return;
    seenStatusesRef.current = statuses;
    if (unreadable) void useSpaceStore.getState().recheckSpaceConfigs();
  }, [statuses, unreadable]);
}
