import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import { useEntrySelectionStore } from "@/features/entry";
import { useToggleCommandPalette } from "@/features/search";
import { useSpace } from "@/features/space";
import { isTerminalKeyboardEvent } from "@/features/terminal";
import { useShellStore } from "../model";

export function useKeyboardShortcuts() {
  const closeDocument = useEntrySelectionStore((state) => state.closeDocument);
  const { toggleChatPanel, openAppSettings } = useShellStore();
  const toggleCommandPalette = useToggleCommandPalette();
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const goHome = useSpace((s) => s.goHome);
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTerminalKeyboardEvent(e)) return;
      const isMeta = e.metaKey || e.ctrlKey;

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
    activeRootPath,
    toggleCommandPalette,
    toggleChatPanel,
    closeDocument,
    openAppSettings,
    goHome,
    navigate,
  ]);
}
