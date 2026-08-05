import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import {
  requestActorMailmapSave,
  requestAgentActorCatalogSave,
} from "@/features/actors";
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
import {
  useScopeSurfaceStore,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";
import { isTerminalKeyboardEvent } from "@/features/terminal";
import { useShellStore } from "../model";
import * as m from "@/paraglide/messages.js";
import {
  runSystemCollectionNavigation,
  useSystemCollectionActivePresentationId,
  useSystemCollectionDetailController,
} from "@/features/collection/system";

export function useKeyboardShortcuts() {
  const detailController = useSystemCollectionDetailController();
  const closeDocument = useCloseEntryDocument();
  const { activeDocument, activeDocumentSpaceId } = useActiveEntrySelection();
  const { toggleChatPanel, openAppSettings } = useShellStore();
  const toggleCommandPalette = useToggleCommandPalette();
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const goHome = useSpace((s) => s.goHome);
  const activeScopeSpace = useSpace((s) => {
    const scopeSpaceId = activeDocumentSpaceId ?? s.activeRootId;
    if (!scopeSpaceId) return null;
    return (
      s.rootSpaces.find((space) => space.id === scopeSpaceId) ??
      s.spaces.find((space) => space.id === scopeSpaceId) ??
      null
    );
  });
  const activeScopeSurface = useScopeSurfaceStore((state) =>
    activeScopeSpace
      ? state.surfaceByOwnerKey[`space:${activeScopeSpace.id}`]
      : undefined,
  );
  const actorsPresentationId = useSystemCollectionActivePresentationId(
    activeScopeSpace ? `actors:space:${activeScopeSpace.id}` : null,
  );
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTerminalKeyboardEvent(e)) return;
      const isMeta = e.metaKey || e.ctrlKey;
      const isSaveKey = isMeta && !e.altKey && e.key.toLowerCase() === "s";

      if (isSaveKey && !activeDocument && activeScopeSpace) {
        e.preventDefault();
        const scope: GitSaveScope = { kind: "space", path: "", label: "space" };
        const saveRoute = resolveScopeSaveShortcutRoute(
          e.shiftKey,
          activeScopeSurface,
        );
        if (saveRoute === "descendants") {
          void commitSaveScopeAndMaybeSync(
            activeScopeSpace.path,
            scope,
            [],
            activeRootPath ?? undefined,
          );
        } else if (saveRoute === "actors") {
          const request = {
            projectPath: activeRootPath ?? activeScopeSpace.path,
            spacePath: activeScopeSpace.path,
          };
          if (actorsPresentationId === "agents") {
            requestAgentActorCatalogSave(request);
          } else {
            requestActorMailmapSave(request);
          }
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
        void runSystemCollectionNavigation(detailController, closeDocument);
      }

      // Cmd+Shift+O — go to home / all projects
      if (isMeta && e.shiftKey && e.key === "o") {
        e.preventDefault();
        void runSystemCollectionNavigation(detailController, () => {
          goHome();
          navigate({ to: "/" });
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeDocument,
    activeRootPath,
    activeScopeSpace,
    activeScopeSurface,
    actorsPresentationId,
    toggleCommandPalette,
    toggleChatPanel,
    closeDocument,
    openAppSettings,
    goHome,
    navigate,
    detailController,
  ]);
}

export function resolveScopeSaveShortcutRoute(
  shiftKey: boolean,
  surface: ScopeSurfaceId | undefined,
): "actors" | "descendants" | "feedback" {
  if (shiftKey) return "descendants";
  return surface === "actors" ? "actors" : "feedback";
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
