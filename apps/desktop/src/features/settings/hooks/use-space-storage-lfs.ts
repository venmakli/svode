import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { LfsState } from "@/features/space";
import {
  diagnoseLfsRemote as diagnoseLfsRemoteApi,
  getLfsState,
  getSettingsGitAvailability,
  listenLfsStateChanged,
  repairLfs as repairLfsApi,
  type LfsRemoteDiagnostic,
} from "../api";

interface UseSpaceStorageLfsOptions {
  open: boolean;
  projectPath: string;
  currentSpaceId: string | null;
  lfsRemoteEnabled: boolean;
}

export function useSpaceStorageLfs({
  open,
  projectPath,
  currentSpaceId,
  lfsRemoteEnabled,
}: UseSpaceStorageLfsOptions) {
  const [lfsAvailable, setLfsAvailable] = useState<boolean>(false);
  const [lfsVersion, setLfsVersion] = useState<string | null>(null);
  const [lfsState, setLfsState] = useState<LfsState>("n/a");
  const [lfsRepairInFlight, setLfsRepairInFlight] = useState(false);
  const [lfsRemoteDiagnostic, setLfsRemoteDiagnostic] =
    useState<LfsRemoteDiagnostic | null>(null);
  const [lfsRemoteDiagnosticInFlight, setLfsRemoteDiagnosticInFlight] =
    useState(false);
  const lfsRemoteDiagnosticInFlightRef = useRef(false);

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

  const diagnoseLfsRemote = useCallback(async () => {
    if (!projectPath || lfsRemoteDiagnosticInFlightRef.current) return;
    lfsRemoteDiagnosticInFlightRef.current = true;
    setLfsRemoteDiagnosticInFlight(true);
    setLfsRemoteDiagnostic(null);
    try {
      const diagnostic = await diagnoseLfsRemoteApi({
        projectPath,
        spaceId: currentSpaceId,
      });
      setLfsRemoteDiagnostic(diagnostic);
      setLfsState(diagnostic.state);
    } catch (err) {
      console.error("diagnose_lfs_remote failed:", err);
      toast.error(m.toast_error());
    } finally {
      lfsRemoteDiagnosticInFlightRef.current = false;
      setLfsRemoteDiagnosticInFlight(false);
    }
  }, [projectPath, currentSpaceId]);

  useEffect(() => {
    if (!open || !lfsRemoteEnabled) {
      setLfsRemoteDiagnostic(null);
      return;
    }
    void diagnoseLfsRemote();
  }, [open, lfsRemoteEnabled, diagnoseLfsRemote]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenLfsStateChanged((event) => {
      if (cancelled) return;
      if (event.payload.projectPath !== projectPath) return;
      if ((event.payload.spaceId ?? null) !== currentSpaceId) return;
      const nextState = event.payload.state;
      setLfsState(nextState);
      setLfsRemoteDiagnostic((current) =>
        current && current.state !== nextState ? null : current,
      );
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
    setLfsRemoteDiagnostic(null);
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
    lfsRemoteDiagnostic,
    lfsRemoteDiagnosticInFlight,
    loadLfsState,
    diagnoseLfsRemote,
    repairLfs,
  };
}
