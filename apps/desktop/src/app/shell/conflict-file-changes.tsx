import { useEffect, useState } from "react";
import { ChangesWindow, fileChangesTarget } from "@/features/changes";
import {
  registerConflictNavigation,
  type ConflictFileTarget,
} from "@/features/git/app-shell";
import { useSpace } from "@/features/space";
import { openRepositoryPage } from "./window-header";

/**
 * Where a conflicted path is resolved (1.F): "Changes" at the file, opened
 * by «Разрешить» of the Git sync Dialog and of a Collection with its schema
 * in conflict, and the Page editor for a conflicted Page.
 */
export function ConflictFileChanges() {
  const [target, setTarget] = useState<ConflictFileTarget | null>(null);
  const [open, setOpen] = useState(false);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  useEffect(
    () =>
      registerConflictNavigation({
        openFile: (next) => {
          setTarget(next);
          setOpen(true);
        },
        openPage: ({ spacePath, path }) =>
          openRepositoryPage({ spacePath, repositoryPath: spacePath, path }),
      }),
    [],
  );
  if (!target) return null;
  return (
    <ChangesWindow
      target={fileChangesTarget({
        spacePath: target.spacePath,
        projectPath: activeRootPath ?? target.spacePath,
        path: target.path,
      })}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
