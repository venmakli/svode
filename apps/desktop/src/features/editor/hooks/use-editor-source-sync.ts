import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import {
  createSourceSync,
  type SourceSync,
  type SourceSyncHost,
} from "../model/source-sync";

/** One source sync per editor instance, always driving the latest host effects. */
export function useEditorSourceSync(host: SourceSyncHost): SourceSync {
  const hostRef = useRef(host);
  useLayoutEffect(() => {
    hostRef.current = host;
  });
  const syncRef = useRef<SourceSync | null>(null);
  const instance = useCallback(() => {
    syncRef.current ??= createSourceSync({
      baseline: (path) => hostRef.current.baseline(path),
      setBaseline: (path, baseline) =>
        hostRef.current.setBaseline(path, baseline),
      hasDraft: (path) => hostRef.current.hasDraft(path),
      whenWritesSettled: () => hostRef.current.whenWritesSettled(),
      readSource: (path) => hostRef.current.readSource(path),
      loadSource: (path, page) => hostRef.current.loadSource(path, page),
      adoptMetadata: (page) => hostRef.current.adoptMetadata(page),
      writeDraft: (path, version) => hostRef.current.writeDraft(path, version),
      setAutoSavePaused: (paused) => hostRef.current.setAutoSavePaused(paused),
      report: (conflict) => hostRef.current.report(conflict),
      onResolved: (choice) => hostRef.current.onResolved(choice),
    });
    return syncRef.current;
  }, []);
  useEffect(() => () => instance().dispose(), [instance]);
  return useMemo(
    () => ({
      reconcile: (...args) => instance().reconcile(...args),
      isOpen: () => instance().isOpen(),
      dispose: () => instance().dispose(),
    }),
    [instance],
  );
}
