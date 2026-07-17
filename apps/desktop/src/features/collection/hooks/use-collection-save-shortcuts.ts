import { useEffect } from "react";
import { toast } from "sonner";
import {
  commitSaveScopeAndMaybeSync,
  dirtyPathsForGitSaveScope,
  getGitSpaceStatus,
  gitSaveShortcutLabel,
  refreshGitSpaceStatus,
  resolveGitSaveAllScope,
  type GitSaveScope,
  type GitSaveScopeLabel,
  type GitSaveScopeTreeNode,
} from "@/features/git/app-shell";
import { isTerminalKeyboardEvent } from "@/features/terminal";
import * as m from "@/paraglide/messages.js";

interface UseCollectionSaveShortcutsInput {
  projectPath?: string | null;
  readmePath: string;
  saveScopeTree: readonly GitSaveScopeTreeNode[];
  spacePath: string;
}

export function useCollectionSaveShortcuts({
  projectPath,
  readmePath,
  saveScopeTree,
  spacePath,
}: UseCollectionSaveShortcutsInput) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (isTerminalKeyboardEvent(event)) return;

      const isSaveKey =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s";
      if (!isSaveKey) return;

      event.preventDefault();
      const saveAllScope = resolveGitSaveAllScope({
        activePath: readmePath,
        tree: saveScopeTree,
      });

      if (event.shiftKey) {
        void commitSaveScopeAndMaybeSync(
          spacePath,
          saveAllScope,
          [],
          projectPath ?? undefined,
        );
        return;
      }

      void showNoEditableSurfaceFeedback(spacePath, saveAllScope);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [projectPath, readmePath, saveScopeTree, spacePath]);
}

async function showNoEditableSurfaceFeedback(
  spacePath: string,
  scope: GitSaveScope,
) {
  try {
    await refreshGitSpaceStatus(spacePath);
  } catch (err) {
    console.error("git_status before collection save feedback failed:", err);
  }

  const dirtyCount = dirtyPathsForGitSaveScope(
    getGitSpaceStatus(spacePath),
    scope,
  ).length;

  if (dirtyCount > 0) {
    toast.info(
      m.git_save_no_surface_scope({
        count: String(dirtyCount),
        scope: gitSaveScopeLabel(scope.label),
        shortcut: gitSaveShortcutLabel("descendants"),
      }),
    );
    return;
  }

  toast.info(m.git_save_no_surface());
}

function gitSaveScopeLabel(label: GitSaveScopeLabel): string {
  switch (label) {
    case "collection":
      return m.git_save_scope_collection();
    case "folder":
      return m.git_save_scope_folder();
    case "document":
      return m.git_save_scope_document();
    case "space":
      return m.git_save_scope_space();
  }
}
