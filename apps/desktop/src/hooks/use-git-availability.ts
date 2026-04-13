import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitAvailability } from "@/types/git";

/**
 * Check if `git` is installed at startup. Returns:
 *  - `null` while the first check is running
 *  - `true`/`false` after the check resolves
 *
 * Exposes a `recheck` function so the missing-git dialog's
 * "Проверить снова" button can re-run detection.
 */
export function useGitAvailability(): {
  available: boolean | null;
  availability: GitAvailability | null;
  recheck: () => Promise<void>;
} {
  const [availability, setAvailability] = useState<GitAvailability | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  const recheck = async () => {
    try {
      const status = await invoke<GitAvailability>("git_check_availability");
      setAvailability(status);
      setAvailable(status.git);
    } catch (err) {
      console.error("git_check_availability failed:", err);
      setAvailable(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async setState after await
    void recheck();
  }, []);

  return { available, availability, recheck };
}
