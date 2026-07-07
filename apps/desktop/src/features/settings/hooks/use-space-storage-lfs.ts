import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  gitAuthChallengeFromRemoteUrl,
  saveGitRemoteCredentials,
  type GitAuthChallenge,
} from "@/features/git";
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
  const [lfsRemoteAuthOpen, setLfsRemoteAuthOpen] = useState(false);
  const [lfsRemoteAuthChallenge, setLfsRemoteAuthChallenge] =
    useState<GitAuthChallenge | null>(null);
  const [lfsRemoteAuthSaving, setLfsRemoteAuthSaving] = useState(false);
  const [lfsRemoteAuthError, setLfsRemoteAuthError] = useState<string | null>(
    null,
  );
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

  const runLfsRemoteDiagnostic = useCallback(
    async (promptForAuth: boolean) => {
      if (!projectPath || lfsRemoteDiagnosticInFlightRef.current) return null;
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
        const authChallenge = authChallengeFromLfsDiagnostic(diagnostic);
        setLfsRemoteAuthChallenge(authChallenge);
        if (promptForAuth && authChallenge) {
          setLfsRemoteAuthError(null);
          setLfsRemoteAuthOpen(true);
        }
        return diagnostic;
      } catch (err) {
        console.error("diagnose_lfs_remote failed:", err);
        toast.error(m.toast_error());
        return null;
      } finally {
        lfsRemoteDiagnosticInFlightRef.current = false;
        setLfsRemoteDiagnosticInFlight(false);
      }
    },
    [projectPath, currentSpaceId],
  );

  const diagnoseLfsRemote = useCallback(async () => {
    await runLfsRemoteDiagnostic(true);
  }, [runLfsRemoteDiagnostic]);

  useEffect(() => {
    if (!open || !lfsRemoteEnabled) {
      setLfsRemoteDiagnostic(null);
      setLfsRemoteAuthChallenge(null);
      return;
    }
    void runLfsRemoteDiagnostic(false);
  }, [open, lfsRemoteEnabled, runLfsRemoteDiagnostic]);

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
      if (next === "missing-creds" && lfsRemoteEnabled) {
        await runLfsRemoteDiagnostic(true);
      }
    } catch (err) {
      console.error("repair_lfs failed:", err);
      toast.error(m.toast_error());
    } finally {
      setLfsRepairInFlight(false);
    }
  }, [
    projectPath,
    currentSpaceId,
    lfsRepairInFlight,
    lfsRemoteEnabled,
    runLfsRemoteDiagnostic,
  ]);

  const setLfsRemoteAuthDialogOpen = useCallback((nextOpen: boolean) => {
    setLfsRemoteAuthOpen(nextOpen);
    if (!nextOpen) {
      setLfsRemoteAuthError(null);
    }
  }, []);

  const saveLfsRemoteAuthAndRetry = useCallback(
    async (credentials: { username: string; password: string }) => {
      if (!lfsRemoteAuthChallenge?.remoteUrl || lfsRemoteAuthSaving) return;
      setLfsRemoteAuthSaving(true);
      setLfsRemoteAuthError(null);
      try {
        await saveGitRemoteCredentials({
          remoteUrl: lfsRemoteAuthChallenge.remoteUrl,
          username: credentials.username,
          password: credentials.password,
        });
        const diagnostic = await runLfsRemoteDiagnostic(false);
        if (!diagnostic) {
          setLfsRemoteAuthError(m.git_remote_auth_save_failed());
          return;
        }
        if (diagnostic?.reason === "auth-required") {
          setLfsRemoteAuthChallenge(
            authChallengeFromLfsDiagnostic(diagnostic) ??
              lfsRemoteAuthChallenge,
          );
          setLfsRemoteAuthError(m.git_remote_auth_invalid_error());
          return;
        }
        setLfsRemoteAuthOpen(false);
        setLfsRemoteAuthChallenge(null);
      } catch (err) {
        console.error("git lfs credential save/retry failed:", err);
        setLfsRemoteAuthError(m.git_remote_auth_save_failed());
      } finally {
        setLfsRemoteAuthSaving(false);
      }
    },
    [lfsRemoteAuthChallenge, lfsRemoteAuthSaving, runLfsRemoteDiagnostic],
  );

  return {
    lfsAvailable,
    lfsVersion,
    lfsState,
    lfsRepairInFlight,
    lfsRemoteDiagnostic,
    lfsRemoteDiagnosticInFlight,
    lfsRemoteAuthOpen,
    lfsRemoteAuthChallenge,
    lfsRemoteAuthSaving,
    lfsRemoteAuthError,
    loadLfsState,
    diagnoseLfsRemote,
    repairLfs,
    setLfsRemoteAuthDialogOpen,
    saveLfsRemoteAuthAndRetry,
  };
}

function authChallengeFromLfsDiagnostic(
  diagnostic: LfsRemoteDiagnostic,
): GitAuthChallenge | null {
  if (diagnostic.reason !== "auth-required") return null;
  if (!diagnostic.remoteUrl) return null;
  return gitAuthChallengeFromRemoteUrl({
    remoteUrl: diagnostic.remoteUrl,
    operation: "lfs-diagnostics",
    detail: diagnostic.detail,
  });
}
