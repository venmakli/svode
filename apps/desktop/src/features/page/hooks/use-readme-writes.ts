import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  ReadmeWriteSession,
  type ReadmeWriteOptions,
} from "../model/readme-write-session";

export function useReadmeWrites({
  targetKey,
  ...options
}: ReadmeWriteOptions & { targetKey: string }) {
  const session = useMemo(() => new ReadmeWriteSession(targetKey), [targetKey]);
  useEffect(() => {
    session.configure(options);
  });
  useEffect(() => {
    session.activate();
    return () => session.dispose();
  }, [session]);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  return {
    ...snapshot,
    createReadme: session.createReadme,
    updateField: session.updateField,
    flush: session.flush,
    retry: session.retry,
  };
}
