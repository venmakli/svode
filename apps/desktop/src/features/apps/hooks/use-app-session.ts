import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controlAppProcess,
  inspectAppManifest,
  listenAppManifestChanges,
  revokeAppSource,
} from "../api/app-api";
import type {
  AppOwner,
  AppProcessControlAction,
  AppSession,
} from "../model/types";

export function useAppSession(owner: AppOwner) {
  const { ownerPath, projectPath, spaceId, spacePath } = owner;
  const [requestKey, setRequestKey] = useState(0);
  const operationRef = useRef(0);
  const sessionKey = `${projectPath}\0${spaceId ?? ""}\0${spacePath}\0${ownerPath}`;
  const [result, setResult] = useState<{
    key: string;
    session: AppSession;
  }>(() => ({ key: sessionKey, session: { status: "loading" } }));
  const refresh = useCallback(
    (showLoading: boolean) => {
      if (showLoading) {
        setResult({ key: sessionKey, session: { status: "loading" } });
      }
      setRequestKey((key) => key + 1);
    },
    [sessionKey],
  );

  useEffect(() => {
    const currentOwner = { ownerPath, projectPath, spaceId, spacePath };
    const operation = ++operationRef.current;
    let cancelled = false;
    let capabilityToken: string | undefined;
    void inspectAppManifest(currentOwner)
      .then((inspection) => {
        if (cancelled || operation !== operationRef.current) {
          if (inspection.status === "ready" && inspection.capabilityToken) {
            void revokeAppSource(inspection.capabilityToken);
          }
          return;
        }
        if (inspection.status === "ready") {
          capabilityToken = inspection.capabilityToken;
          setResult({ key: sessionKey, session: inspection });
          return;
        }
        setResult({ key: sessionKey, session: inspection });
      })
      .catch(() => {
        if (!cancelled && operation === operationRef.current) {
          setResult({ key: sessionKey, session: { status: "error" } });
        }
      });

    return () => {
      cancelled = true;
      if (capabilityToken) void revokeAppSource(capabilityToken);
    };
  }, [ownerPath, projectPath, requestKey, sessionKey, spaceId, spacePath]);

  useEffect(() => {
    const currentOwner = { ownerPath, projectPath, spaceId, spacePath };
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenAppManifestChanges(currentOwner, () => refresh(true)).then(
      (nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ownerPath, projectPath, refresh, spaceId, spacePath]);

  const session = useMemo<AppSession>(
    () => (result.key === sessionKey ? result.session : { status: "loading" }),
    [result, sessionKey],
  );

  useEffect(() => {
    const delay =
      session.status === "launching"
        ? 250
        : session.status === "ready" && session.runtimeType === "process"
          ? 1_000
          : null;
    if (delay === null) return;
    const timer = window.setTimeout(() => refresh(false), delay);
    return () => window.clearTimeout(timer);
  }, [refresh, session]);

  const runProcessControl = useCallback(
    (action: AppProcessControlAction) => {
      const currentOwner = { ownerPath, projectPath, spaceId, spacePath };
      const operation = ++operationRef.current;
      setResult({ key: sessionKey, session: { status: "loading" } });
      void controlAppProcess(currentOwner, action)
        .then((inspection) => {
          if (operation === operationRef.current) {
            setResult({ key: sessionKey, session: inspection });
          }
        })
        .catch(() => {
          if (operation === operationRef.current) {
            setResult({ key: sessionKey, session: { status: "error" } });
          }
        });
    },
    [ownerPath, projectPath, sessionKey, spaceId, spacePath],
  );

  const retry = useCallback(() => {
    if (
      session.status === "unavailable" &&
      session.runtimeType === "process" &&
      session.reason !== "process_environment_pending"
    ) {
      runProcessControl("retry");
      return;
    }
    refresh(true);
  }, [refresh, runProcessControl, session]);

  return {
    rerunSetup: () => runProcessControl("rerun_setup"),
    restart: () => runProcessControl("restart"),
    retry,
    session,
    stop: () => runProcessControl("stop"),
  };
}
