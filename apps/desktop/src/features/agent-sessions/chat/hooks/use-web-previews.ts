import { useEffect, useMemo, useState } from "react";
import { htmlDocumentApp } from "@/features/document";
import { normalizeGitStatusPath, useGitStore } from "@/features/git";
import { useSpace } from "@/features/space";
import { attachmentExists } from "../api/attachments";
import { locateAttachment } from "../model/attachments";
import type { ChangedFile, TurnChanges } from "../model/changed-files";
import { webPreviewCandidates, webPreviewFiles } from "../model/web-previews";

export interface WebPreview {
  file: ChangedFile;
  /** The file is gone: its card does nothing. */
  removed: boolean;
}

interface Resolved {
  key: string;
  appFiles: ReadonlySet<string>;
  removed: ReadonlySet<string>;
}

/**
 * The «Веб-превью» cards of a finished turn (Stage 11 `06` H1), once it is
 * known which candidates are files of an App of the project and which are
 * gone. Empty until then. A file saved, restored or deleted in a Space
 * changes its Git status, which checks the cards again.
 */
export function useWebPreviews(changes: TurnChanges | null): WebPreview[] {
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const spaces = useSpace((state) => state.spaces);
  const activeRootId = useSpace((state) => state.activeRootId);
  const projectPath = rootSpaces.find(
    (space) => space.id === activeRootId,
  )?.path;
  const known = useMemo(() => [...rootSpaces, ...spaces], [rootSpaces, spaces]);
  const candidates = webPreviewCandidates(changes, known);
  const key = candidates.map((file) => file.path).join("\n");

  // The Git state of each candidate in the project; "" outside or clean.
  // As a string, a status change elsewhere does not render the turn again.
  const statusKey = useGitStore((state) =>
    key
      .split("\n")
      .map((path) => {
        const location = locateAttachment(path, known);
        if (!location) return "";
        const relative = normalizeGitStatusPath(location.path);
        return (
          state.statuses[location.spacePath]?.files.find(
            (file) => normalizeGitStatusPath(file.path) === relative,
          )?.state ?? ""
        );
      })
      .join("\n"),
  );

  const [resolved, setResolved] = useState<Resolved | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void Promise.all(
      key.split("\n").map(async (path) => {
        const location = locateAttachment(path, known);
        const [app, exists] = await Promise.all([
          location
            ? htmlDocumentApp({
                projectPath: projectPath ?? location.spacePath,
                spaceId:
                  location.spaceId === activeRootId ? null : location.spaceId,
                path: location.path,
              }).catch(() => null)
            : null,
          attachmentExists(path).catch(() => false),
        ]);
        return { path, app: app !== null, exists };
      }),
    ).then((facts) => {
      if (cancelled) return;
      setResolved({
        key,
        appFiles: new Set(
          facts.filter((fact) => fact.app).map((fact) => fact.path),
        ),
        removed: new Set(
          facts.filter((fact) => !fact.exists).map((fact) => fact.path),
        ),
      });
    });
    return () => {
      cancelled = true;
    };
    // A changed Git state of a candidate may mean it is gone or back.
  }, [activeRootId, key, known, projectPath, statusKey]);

  if (!key || resolved?.key !== key) return [];
  return webPreviewFiles(candidates, resolved.appFiles).map((file) => ({
    file,
    removed: resolved.removed.has(file.path),
  }));
}
