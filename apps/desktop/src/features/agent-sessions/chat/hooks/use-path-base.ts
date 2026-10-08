import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { homeFolder } from "../api/attachments";
import type { PathBase } from "../model/text-paths";

/** The working directory of the session the chat shows. */
export const SessionCwdContext = createContext<string | null>(null);

/** What paths in the session's text resolve against: its cwd and `~`. */
export function usePathBase(): PathBase {
  const cwd = useContext(SessionCwdContext);
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void homeFolder().then((folder) => {
      if (!cancelled) setHome(folder);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => ({ cwd, home }), [cwd, home]);
}
