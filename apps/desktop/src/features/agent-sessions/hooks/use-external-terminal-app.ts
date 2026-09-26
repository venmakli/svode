import { useEffect, useState } from "react";

import type { ExternalAppDto } from "@/platform/project-openers";

import { loadExternalTerminalApp } from "../api";

/** The installed terminal that opens a session cwd, loaded once per mount. */
export function useExternalTerminalApp(): ExternalAppDto | null {
  const [app, setApp] = useState<ExternalAppDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadExternalTerminalApp().then(
      (next) => {
        if (!cancelled) setApp(next);
      },
      (error: unknown) => {
        console.error("Failed to load the external terminal:", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return app;
}
