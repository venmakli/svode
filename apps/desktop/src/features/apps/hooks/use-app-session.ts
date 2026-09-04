import { useCallback, useEffect, useState } from "react";
import {
  inspectAppManifest,
  listenAppManifestChanges,
  revokeAppSource,
} from "../api/app-api";
import type { AppOwner, AppSession } from "../model/types";

export function useAppSession(owner: AppOwner) {
  const { ownerPath, projectPath, spaceId, spacePath } = owner;
  const [requestKey, setRequestKey] = useState(0);
  const sessionKey = `${projectPath}\0${spaceId ?? ""}\0${spacePath}\0${ownerPath}\0${requestKey}`;
  const [result, setResult] = useState<{
    key: string;
    session: AppSession;
  }>(() => ({ key: sessionKey, session: { status: "loading" } }));
  const retry = useCallback(() => setRequestKey((key) => key + 1), []);

  useEffect(() => {
    const currentOwner = { ownerPath, projectPath, spaceId, spacePath };
    let cancelled = false;
    let capabilityToken: string | undefined;
    void inspectAppManifest(currentOwner)
      .then((inspection) => {
        if (cancelled) {
          if (inspection.status === "ready" && inspection.capabilityToken) {
            void revokeAppSource(inspection.capabilityToken);
          }
          return;
        }
        if (inspection.status === "ready") {
          capabilityToken = inspection.capabilityToken;
          setResult({
            key: sessionKey,
            session: {
              status: "ready",
              ownerDirectory: inspection.ownerDirectory,
              runtimeType: inspection.runtimeType,
              viewportUrl: inspection.viewportUrl,
              capabilityToken,
            },
          });
          return;
        }
        setResult({ key: sessionKey, session: inspection });
      })
      .catch(() => {
        if (!cancelled) {
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
    void listenAppManifestChanges(currentOwner, retry).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ownerPath, projectPath, retry, spaceId, spacePath]);

  const session: AppSession =
    result.key === sessionKey ? result.session : { status: "loading" };

  return { retry, session };
}
