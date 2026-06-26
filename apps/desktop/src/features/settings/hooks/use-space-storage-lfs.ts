import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { LfsState } from "@/features/space";
import {
  getLfsState,
  getSettingsGitAvailability,
  listenLfsStateChanged,
  repairLfs as repairLfsApi,
} from "../api";

interface UseSpaceStorageLfsOptions {
  open: boolean;
  projectPath: string;
  currentSpaceId: string | null;
}

export function useSpaceStorageLfs({
  open,
  projectPath,
  currentSpaceId,
}: UseSpaceStorageLfsOptions) {
  const [lfsAvailable, setLfsAvailable] = useState<boolean>(false);
  const [lfsVersion, setLfsVersion] = useState<string | null>(null);
  const [lfsState, setLfsState] = useState<LfsState>("n/a");
  const [lfsRepairInFlight, setLfsRepairInFlight] = useState(false);

  const loadLfsState = useCallback(async () => {
    if (!projectPath) return;
    try {
      const state = await getLfsState({
        projectPath,
        spaceId: currentSpaceId,
      });
      setLfsState(state);
    } catch (err) {
      console.warn("get_lfs_state failed:", err);
      setLfsState("n/a");
    }
  }, [projectPath, currentSpaceId]);

  const loadLfsAvailability = useCallback(async () => {
    try {
      const avail = await getSettingsGitAvailability();
      setLfsAvailable(avail.gitLfs);
      setLfsVersion(avail.gitLfsVersion);
    } catch {
      setLfsAvailable(false);
      setLfsVersion(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadLfsAvailability();
    void loadLfsState();
  }, [open, loadLfsAvailability, loadLfsState]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenLfsStateChanged((event) => {
      if (cancelled) return;
      if (event.payload.projectPath !== projectPath) return;
      if ((event.payload.spaceId ?? null) !== currentSpaceId) return;
      setLfsState(event.payload.state);
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [open, projectPath, currentSpaceId]);

  const repairLfs = useCallback(async () => {
    if (!projectPath || lfsRepairInFlight) return;
    setLfsRepairInFlight(true);
    try {
      const next = await repairLfsApi({
        projectPath,
        spaceId: currentSpaceId,
      });
      setLfsState(next);
    } catch (err) {
      console.error("repair_lfs failed:", err);
      toast.error(m.toast_error());
    } finally {
      setLfsRepairInFlight(false);
    }
  }, [projectPath, currentSpaceId, lfsRepairInFlight]);

  return {
    lfsAvailable,
    lfsVersion,
    lfsState,
    lfsRepairInFlight,
    loadLfsState,
    repairLfs,
  };
}
