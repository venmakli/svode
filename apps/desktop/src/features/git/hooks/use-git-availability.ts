import { useCallback, useEffect, useState } from "react";
import type { GitAvailability } from "../model";
import { getGitAvailability } from "../api/git-availability-actions";

/**
 * Check if a usable `git` is installed at startup. Returns:
 *  - `null` while the first check is running
 *  - `true`/`false` after the check resolves; a Git older than the minimum
 *    Svode supports is not usable
 *
 * Exposes a stable `recheck` function so the missing-git dialog's
 * "Проверить снова" button can re-run detection. A recheck keeps the last
 * answer until the new one arrives.
 */
export function useGitAvailability(): {
  available: boolean | null;
  availability: GitAvailability | null;
  recheck: () => Promise<void>;
} {
  const [availability, setAvailability] = useState<GitAvailability | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  const recheck = useCallback(async () => {
    try {
      const status = await getGitAvailability();
      setAvailability(status);
      setAvailable(status.git && status.gitVersionSupported);
    } catch (err) {
      console.error("git_check_availability failed:", err);
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async setState after await
    void recheck();
  }, [recheck]);

  return { available, availability, recheck };
}
