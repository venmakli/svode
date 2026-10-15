import { useCallback, useEffect, useRef, useState } from "react";

import {
  AttachmentSourceSession,
  type AttachmentSourceView,
} from "../model/source-session";
import type {
  AttachmentOwnerInput,
  AttachmentRow,
  AttachmentsSnapshot,
} from "../model/types";

/**
 * A read-only folder another feature lists, such as a skill folder: `read`
 * returns the rows directly inside a branch, `null` naming the folder itself.
 */
export interface AttachmentsFolder {
  key: string;
  read(branchPath: string | null): Promise<readonly AttachmentRow[]>;
  /** Changes when the folder may have changed; shown branches reload. */
  revision: string | number;
}

/**
 * The root and branch session of Attachments over a foreign folder. `read`
 * keeps its identity while it reads the same folder.
 */
export function useAttachmentsFolderSource({
  key,
  read,
  revision,
}: AttachmentsFolder) {
  const [view, setView] = useState<AttachmentSourceView>({
    state: { phase: "initial" },
    branches: new Map(),
    expanded: new Set(),
  });
  const sessionRef = useRef<AttachmentSourceSession | null>(null);
  const shownRevisionRef = useRef(revision);
  const refresh = useCallback(async () => {
    await sessionRef.current?.refresh();
  }, []);
  const loadBranch = useCallback(async (path: string) => {
    await sessionRef.current?.loadBranch(path);
  }, []);
  const toggle = useCallback((path: string) => {
    sessionRef.current?.toggle(path);
  }, []);
  const observeBranch = useCallback(
    (path: string) => sessionRef.current?.observe(path),
    [],
  );
  const retainPeekTarget = useCallback(
    (row: AttachmentRow) => sessionRef.current?.retainPeekTarget(row),
    [],
  );
  const inventory = useCallback(
    () => sessionRef.current?.inventory() ?? null,
    [],
  );

  useEffect(() => {
    const owner: AttachmentOwnerInput = {
      ownerPath: ".",
      projectPath: key,
      spaceId: null,
    };
    const session = new AttachmentSourceSession(
      owner,
      async (input) =>
        folderSnapshot(key, await read(input.branchPath ?? null)),
      (next) => setView(next),
    );
    sessionRef.current = session;
    queueMicrotask(() => {
      if (sessionRef.current === session) {
        setView(session.current);
        void session.refreshRoot();
      }
    });
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [key, read]);

  useEffect(() => {
    if (shownRevisionRef.current === revision) return;
    shownRevisionRef.current = revision;
    sessionRef.current?.invalidate();
    void sessionRef.current?.refresh();
  }, [revision]);

  return {
    refresh,
    loadBranch,
    toggle,
    inventory,
    observeBranch,
    retainPeekTarget,
    ...view,
  };
}

function folderSnapshot(
  key: string,
  rows: readonly AttachmentRow[],
): AttachmentsSnapshot {
  return {
    diagnostics: [],
    generation: rows.map((row) => `${row.key}:${row.modified}`).join("\0"),
    owner: {
      ownerPath: ".",
      projectPath: key,
      repositoryPath: key,
      spaceId: null,
      spacePath: key,
    },
    rows: [...rows],
  };
}
