import { useEffect, useState } from "react";
import { listenAppSourceChanges } from "../api/app-api";
import type { AppSession } from "../model/types";

// A series of writes, such as an agent regenerating its data, settles first.
export const APP_SOURCE_RELOAD_DELAY_MS = 300;

// Counts settled changes of the files an open static App serves; each new
// value is one reload of its viewport.
export function useAppSourceReload(session: AppSession): number {
  const capabilityToken =
    session.status === "ready" && session.runtimeType === "static"
      ? session.capabilityToken
      : undefined;
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!capabilityToken) return;
    let disposed = false;
    let timer: number | undefined;
    let unlisten: (() => void) | undefined;
    void listenAppSourceChanges(capabilityToken, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setRevision((value) => value + 1),
        APP_SOURCE_RELOAD_DELAY_MS,
      );
    }).then((next) => {
      if (disposed) next();
      else unlisten = next;
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [capabilityToken]);

  return revision;
}
