import {
  isMacKeyboardPlatform,
  matchesPhysicalShortcut,
} from "@/shared/lib/keyboard-shortcuts";
import { closeTopPeek } from "@/shared/lib/peek-stack";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  requestActorMailmapSave,
  requestAgentActorCatalogSave,
} from "@/features/actors";
import {
  useActiveContentPath,
  useActiveContentSpaceId,
} from "@/features/artifact";
import { isInsideAgentSessionContent } from "@/features/agent-sessions";
import {
  commitSaveScopeAndMaybeSync,
  dirtyPathsForGitSaveScope,
  getGitSpaceStatus,
  gitSaveShortcutLabel,
  type GitSaveScope,
  type GitSaveScopeLabel,
} from "@/features/git/app-shell";
import {
  repositoryAccessIsEditable,
  useRepositoryAccess,
} from "@/features/git";
import { useToggleCommandPalette } from "@/features/search/app-shell";
import { useSpace } from "@/features/space";
import {
  useScopeSurfaceStore,
  type ScopeSurfaceId,
} from "@/features/scope-surfaces";
import {
  isTerminalKeyboardEvent,
  isTerminalToggleShortcut,
  useTerminalPanelToggle,
} from "@/features/terminal";
import { useShellStore } from "../model";
import { useWorkingSetActions } from "../working-set";
import { useShellView } from "../shell-view";
import { useGoHome } from "./use-go-home";
import * as m from "@/paraglide/messages.js";
import { useCollectionActivePresentationId } from "@/features/collection";

export function useKeyboardShortcuts() {
  const { closeMainAreaObject } = useWorkingSetActions();
  const activeContentPath = useActiveContentPath();
  const activeContentSpaceId = useActiveContentSpaceId();
  const { openAppSettings } = useShellStore();
  const toggleCommandPalette = useToggleCommandPalette();
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const goHome = useGoHome();
  // Home has no terminal panel, Search or Graph, and ⌘0 is where it is.
  const home = useShellView() === "home";
  const activeScopeSpace = useSpace((s) => {
    const scopeSpaceId = activeContentSpaceId ?? s.activeRootId;
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
  const repositoryAccess = useRepositoryAccess(activeScopeSpace?.path ?? "");
  const activeScopeReadOnly = !repositoryAccessIsEditable(repositoryAccess);
  const actorsPresentationId = useCollectionActivePresentationId(
    activeScopeSpace ? `actors:space:${activeScopeSpace.id}` : null,
  );
  const terminalPanel = useTerminalPanelToggle();
  const terminalAvailable = terminalPanel.available && !home;
  const toggleTerminal = terminalPanel.toggle;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+` toggles the terminal from any focus, including the terminal itself.
      if (isTerminalToggleShortcut(e)) {
        if (!terminalAvailable) return;
        e.preventDefault();
        toggleTerminal();
        return;
      }
      // ⌘W closes the top peek, else the main area object. In a terminal it
      // works only inside session content and only as Cmd: Ctrl+W belongs
      // to the shell; the terminal panel takes no ⌘W.
      if (matchesPhysicalShortcut(e, "KeyW")) {
        const inTerminal = isTerminalKeyboardEvent(e);
        if (inTerminal && !isMacKeyboardPlatform()) return;
        e.preventDefault();
        if (inTerminal && !isInsideAgentSessionContent(e.target)) return;
        if (!closeTopPeek()) void closeMainAreaObject();
        return;
      }
      // ⌘0 goes Home. In a terminal it works only as Cmd: Ctrl+0 belongs to
      // the shell.
      if (matchesPhysicalShortcut(e, "Digit0")) {
        if (isTerminalKeyboardEvent(e) && !isMacKeyboardPlatform()) return;
        e.preventDefault();
        if (!home) void goHome();
        return;
      }
      if (isTerminalKeyboardEvent(e)) return;
      const isMeta = e.metaKey || e.ctrlKey;
      const isSaveKey = isMeta && !e.altKey && e.key.toLowerCase() === "s";

      if (isSaveKey && !activeContentPath && activeScopeSpace) {
        e.preventDefault();
        const scope: GitSaveScope = { kind: "space", path: "", label: "space" };
        const saveRoute = resolveScopeSaveShortcutRoute(
          e.shiftKey,
          activeScopeSurface,
          activeScopeReadOnly,
        );
        if (saveRoute === "blocked") {
          return;
        } else if (saveRoute === "descendants") {
          void commitSaveScopeAndMaybeSync(
            activeScopeSpace.path,
            scope,
            [],
            activeRootPath ?? undefined,
          ).catch(console.error);
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

      // Cmd/Ctrl+P - open project command palette.
      if (!home && activeRootPath && matchesPhysicalShortcut(e, "KeyP")) {
        e.preventDefault();
        toggleCommandPalette();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeContentPath,
    activeRootPath,
    activeScopeSpace,
    activeScopeReadOnly,
    activeScopeSurface,
    actorsPresentationId,
    toggleCommandPalette,
    closeMainAreaObject,
    openAppSettings,
    goHome,
    home,
    terminalAvailable,
    toggleTerminal,
  ]);
}

export function resolveScopeSaveShortcutRoute(
  shiftKey: boolean,
  surface: ScopeSurfaceId | undefined,
  readOnly = false,
): "actors" | "blocked" | "descendants" | "feedback" {
  if (readOnly) return "blocked";
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
    case "page":
      return m.git_save_scope_page();
    case "space":
      return m.git_save_scope_space();
  }
}
