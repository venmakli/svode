import { useEffect } from "react";
import { useLayoutStore } from "@/stores/layout";

export function useKeyboardShortcuts() {
  const { toggleChatPanel, closeDocument } = useLayoutStore();

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
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleChatPanel, closeDocument]);
}
