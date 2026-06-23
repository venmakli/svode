import { useEffect } from "react";

import { isTerminalKeyboardEvent } from "@/features/terminal";

interface UseEditorSaveShortcutsInput {
  onSave: () => void | Promise<void>;
  onSaveAll: () => void | Promise<void>;
}

export function useEditorSaveShortcuts({
  onSave,
  onSaveAll,
}: UseEditorSaveShortcutsInput) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTerminalKeyboardEvent(event)) return;
      const isSaveKey =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
      if (!isSaveKey) return;

      event.preventDefault();
      if (event.shiftKey) {
        void onSaveAll();
      } else {
        void onSave();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave, onSaveAll]);
}
