import { useEffect } from "react";
import { isTerminalKeyboardEvent } from "@/features/terminal";
import { matchesPhysicalShortcut } from "@/shared/lib/keyboard-shortcuts";

/** ⌘N on Home opens "Create project". */
export function useCreateProjectShortcut(openCreateDialog: () => void) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isTerminalKeyboardEvent(e) && matchesPhysicalShortcut(e, "KeyN")) {
        e.preventDefault();
        openCreateDialog();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openCreateDialog]);
}
