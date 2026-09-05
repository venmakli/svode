import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dispatchPageSave,
  useGitStore,
  hasPageSaveOwner,
  repositoryAccessIsEditable,
  useRepositoryAccess,
  useRepositoryAccessPreflight,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { commitSaveScopeAndMaybeSync } from "@/features/git/editor";
import { inspectionSaveScope, resolveInspectionScope } from "../model/scope";
import type { ChangesTarget } from "../model/scope";

export function useChangesSave(target: ChangesTarget, open: boolean) {
  const access = useRepositoryAccess(target.spacePath);
  const recovery = useRepositoryAccessPreflight();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"failed" | "partial" | null>(null);
  const busy = useRef(false);
  const statusError = useGitStore(
    (state) => state.statusErrors[target.spacePath] ?? false,
  );
  const editable = repositoryAccessIsEditable(access);
  const save = useCallback(
    async function saveIntent(all = false): Promise<void> {
      if (busy.current || !editable || statusError) return;
      busy.current = true;
      setSaving(true);
      setError(null);
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
        const partial = Boolean(
          error &&
          typeof error === "object" &&
          "kind" in error &&
          error.kind === "git_save_partial",
        );
        setError(partial ? "partial" : "failed");
        const cause =
          partial && error && typeof error === "object" && "cause" in error
            ? error.cause
            : error;
        await recovery.recoverFromError(cause, {
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
        busy.current = false;
        setSaving(false);
      }
    },
    [editable, recovery, target, statusError],
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
  return { access, editable, recovery, saving, error, save };
}
