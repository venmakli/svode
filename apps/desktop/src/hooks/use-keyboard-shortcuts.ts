import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutStore } from "@/stores/layout";
import { useSpaceStore } from "@/stores/space";
import { isTerminalKeyboardEvent } from "@/features/terminal";

export function useKeyboardShortcuts() {
  const { toggleChatPanel, closeDocument, openAppSettings } = useLayoutStore();
  const goHome = useSpaceStore((s) => s.goHome);
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

      // Cmd+R — toggle chat panel
      if (isMeta && e.key === "r") {
        e.preventDefault();
        toggleChatPanel();
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
  }, [toggleChatPanel, closeDocument, openAppSettings, goHome, navigate]);
}
