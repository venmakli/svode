import { useCallback, useEffect, useState } from "react";
import { countBrokenLinks } from "../api";

interface UseSpaceSettingsHealthOptions {
  open: boolean;
  active: boolean;
  activeRootPath: string | null;
  isRoot: boolean;
}

export function useSpaceSettingsHealth({
  open,
  active,
  activeRootPath,
  isRoot,
}: UseSpaceSettingsHealthOptions) {
  const [brokenLinksCount, setBrokenLinksCount] = useState<number | null>(null);
  const [linkHealthLoading, setLinkHealthLoading] = useState(false);

  const loadLinkHealth = useCallback(async () => {
    if (!activeRootPath || !isRoot) return;
    setLinkHealthLoading(true);
    try {
      const count = await countBrokenLinks(activeRootPath);
      setBrokenLinksCount(count);
    } catch (err) {
      console.warn("count_broken_links failed:", err);
      setBrokenLinksCount(null);
    } finally {
      setLinkHealthLoading(false);
    }
  }, [activeRootPath, isRoot]);

  useEffect(() => {
    if (open && active) void loadLinkHealth();
  }, [open, active, loadLinkHealth]);

  return {
    brokenLinksCount,
    linkHealthLoading,
    loadLinkHealth,
  };
}
