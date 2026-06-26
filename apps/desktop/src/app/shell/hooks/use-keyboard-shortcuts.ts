import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import {
  useActiveEntrySelection,
  useCloseEntryDocument,
} from "@/features/entry/selection";
import {
  commitSaveScopeAndMaybeSync,
  dirtyPathsForGitSaveScope,
  getGitSpaceStatus,
  gitSaveShortcutLabel,
  type GitSaveScope,
  type GitSaveScopeLabel,
} from "@/features/git/app-shell";
import { useToggleCommandPalette } from "@/features/search/app-shell";
import { useSpace } from "@/features/space";
import { isTerminalKeyboardEvent } from "@/features/terminal";
import { useShellStore } from "../model";
import * as m from "@/paraglide/messages.js";

export function useKeyboardShortcuts() {
  const closeDocument = useCloseEntryDocument();
  const { activeDocument, activeDocumentSpaceId } = useActiveEntrySelection();
  const { toggleChatPanel, openAppSettings } = useShellStore();
  const toggleCommandPalette = useToggleCommandPalette();
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const goHome = useSpace((s) => s.goHome);
  const activeScopeSpace = useSpace((s) => {
    if (!activeDocumentSpaceId) return null;
    return (
      s.rootSpaces.find((space) => space.id === activeDocumentSpaceId) ??
      s.spaces.find((space) => space.id === activeDocumentSpaceId) ??
      null
    );
  });
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTerminalKeyboardEvent(e)) return;
      const isMeta = e.metaKey || e.ctrlKey;
      const isSaveKey = isMeta && !e.altKey && e.key.toLowerCase() === "s";

      if (isSaveKey && !activeDocument && activeScopeSpace) {
        e.preventDefault();
        const scope: GitSaveScope = { kind: "space", path: "", label: "space" };
        if (e.shiftKey) {
          void commitSaveScopeAndMaybeSync(
            activeScopeSpace.path,
            scope,
            [],
            activeRootPath ?? undefined,
          );
        } else {
          showNoEditableSurfaceFeedback(activeScopeSpace.path, scope);
        }
        return;
      }

      // Cmd+, — open app settings
      if (isMeta && e.key === ",") {
        e.preventDefault();
        openAppSettings();
      }

      if (ENABLE_IN_APP_CHAT && isMeta && e.key === "r") {
        e.preventDefault();
        toggleChatPanel();
      }

      // Cmd/Ctrl+P - open project command palette.
      if (
        activeRootPath &&
        isMeta &&
        e.key.toLowerCase() === "p" &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        toggleCommandPalette();
      }

      // Cmd+W — close document
      if (isMeta && e.key === "w") {
        e.preventDefault();
        closeDocument();
      }

      // Cmd+Shift+O — go to home / all projects
      if (isMeta && e.shiftKey && e.key === "o") {
        e.preventDefault();
        goHome();
        navigate({ to: "/" });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeDocument,
    activeRootPath,
    activeScopeSpace,
    toggleCommandPalette,
    toggleChatPanel,
    closeDocument,
    openAppSettings,
    goHome,
    navigate,
  ]);
}

function showNoEditableSurfaceFeedback(spacePath: string, scope: GitSaveScope) {
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
