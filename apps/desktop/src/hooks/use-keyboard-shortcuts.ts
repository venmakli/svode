import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";

export function useKeyboardShortcuts() {
  const { toggleChatPanel, closeDocument } = useLayoutStore();
  const goHome = useWorkspaceStore((s) => s.goHome);
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;

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
  }, [toggleChatPanel, closeDocument, goHome, navigate]);
}
