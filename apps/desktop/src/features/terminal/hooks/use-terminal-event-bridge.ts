import { useEffect } from "react";
import {
  onTerminalError,
  onTerminalExit,
  onTerminalOutput,
} from "@/features/terminal/api/terminal";
import { publishTerminalOutput } from "@/features/terminal/lib/output-bus";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";

export function useTerminalEventBridge() {
  const markExited = useTerminalStore((state) => state.markExited);
  const markError = useTerminalStore((state) => state.markError);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    function addUnlistener(unlisten: () => void) {
      if (cancelled) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    }

    void onTerminalOutput((event) => {
      publishTerminalOutput(event.ptyId, event.data);
    })
      .then(addUnlistener)
      .catch((error) => {
        console.warn("Failed to listen to terminal output:", error);
      });

    void onTerminalExit((event) => {
      markExited(event.ptyId);
    })
      .then(addUnlistener)
      .catch((error) => {
        console.warn("Failed to listen to terminal exits:", error);
      });

    void onTerminalError((event) => {
      markError(event.ptyId, event.message);
    })
      .then(addUnlistener)
      .catch((error) => {
        console.warn("Failed to listen to terminal errors:", error);
      });

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [markError, markExited]);
}
