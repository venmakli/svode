import { useCallback, useEffect, useRef, useState } from "react";
import {
  dispatchPageSave,
  repositoryAccessIsEditable,
  useRepositoryAccess,
  useRepositoryAccessPreflight,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import type { ChangesTarget } from "../model/scope";

export function useChangesSave(target: ChangesTarget, open: boolean) {
  const access = useRepositoryAccess(target.spacePath);
  const recovery = useRepositoryAccessPreflight();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"failed" | "partial" | null>(null);
  const busy = useRef(false);
  const editable = repositoryAccessIsEditable(access);
  const save = useCallback(
    async function saveIntent(all = false): Promise<void> {
      if (busy.current || !editable) return;
      busy.current = true;
      setSaving(true);
      setError(null);
      try {
        await dispatchPageSave(target.spacePath, target.path, all);
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
    [editable, recovery, target],
  );
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s")
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void save(event.shiftKey);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, save]);
  return { access, editable, recovery, saving, error, save };
}
