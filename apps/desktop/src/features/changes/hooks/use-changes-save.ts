import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dispatchPageSave,
  useGitStore,
  hasPageSaveOwner,
  repositoryAccessIsEditable,
  useRepositoryAccess,
  useRepositoryAccessPreflight,
  gitSaveErrorFromError,
  type GitSaveError,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { commitSaveScopeAndMaybeSync } from "@/features/git/editor";
import { inspectionSaveScope, resolveInspectionScope } from "../model/scope";
import type { ChangesTarget } from "../model/scope";

export function useChangesSave(target: ChangesTarget, open: boolean) {
  const access = useRepositoryAccess(target.spacePath);
  const recovery = useRepositoryAccessPreflight();
  const targetKey = JSON.stringify([
    target.spacePath,
    target.projectPath,
    target.kind,
    target.sourceShape,
    target.path,
    target.sessionKey,
  ]);
  const [state, setState] = useState<{
    key: string;
    saving: boolean;
    error: GitSaveError | null;
  } | null>(null);
  if (state && state.key !== targetKey) setState(null);
  const busy = useRef(false);
  const active = useRef<{ key: string } | null>(null);
  const closeRecovery = recovery.close;
  useEffect(() => {
    active.current = { key: targetKey };
    busy.current = false;
    return () => {
      active.current = null;
      closeRecovery();
    };
  }, [targetKey, closeRecovery]);
  const statusError = useGitStore(
    (state) => state.statusErrors[target.spacePath] ?? false,
  );
  const editable = repositoryAccessIsEditable(access);
  const save = useCallback(
    async function saveIntent(all = false): Promise<void> {
      const owner = active.current;
      if (
        !owner ||
        owner.key !== targetKey ||
        busy.current ||
        !editable ||
        statusError
      )
        return;
      busy.current = true;
      setState({ key: targetKey, saving: true, error: null });
      try {
        const aggregate = resolveInspectionScope(target).kind !== "file";
        if (hasPageSaveOwner(target.spacePath, target.path)) {
          await dispatchPageSave(
            target.spacePath,
            target.path,
            all,
            all && aggregate ? inspectionSaveScope(target) : undefined,
          );
        } else if (all && aggregate) {
          await commitSaveScopeAndMaybeSync(
            target.spacePath,
            inspectionSaveScope(target),
            [],
            target.projectPath ?? undefined,
          );
        } else if (aggregate) {
          toast.info(m.git_save_no_surface());
        } else {
          await dispatchPageSave(target.spacePath, target.path, all);
        }
      } catch (error) {
        if (active.current !== owner) return;
        const failure = gitSaveErrorFromError(error);
        const partial = failure.outcome === "partial";
        setState({ key: targetKey, saving: true, error: failure });
        await recovery.recoverFromError(error, {
          intentKey: `changes:${target.spacePath}:${target.path}`,
          intentLabel: m.changes_save(),
          continuation: "explicit",
          placement: "inline",
          targets: [
            {
              displayName: target.name,
              displayPath: target.path,
              repositoryPath:
                partial && target.projectPath
                  ? target.projectPath
                  : target.spacePath,
            },
          ],
          continue: () => saveIntent(all),
        });
      } finally {
        if (active.current === owner) {
          busy.current = false;
          setState((previous) =>
            previous ? { ...previous, saving: false } : null,
          );
        }
      }
    },
    [editable, recovery, target, targetKey, statusError],
  );
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "s"
      )
        return;
      if (!event.shiftKey && target.kind !== "page") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void save(event.shiftKey);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, save, target.kind]);
  return {
    access,
    editable,
    recovery,
    save,
    saving: state?.key === targetKey && state.saving,
    error: state?.key === targetKey ? state.error : null,
  };
}
