import { useCallback } from "react";
import { toast } from "sonner";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { sessionTerminalAgentsBusy, sessionTerminalPtyIds } from "../model";
import { useAgentSessionCatalog } from "./use-agent-session-catalog";
import * as m from "@/paraglide/messages.js";

export interface SessionTerminals {
  /** Open session terminals of the project; shell tabs are not counted. */
  count: number;
  /** Closing them would interrupt a working or waiting agent. */
  agentsBusy: boolean;
  closeAll: () => Promise<void>;
}

/** The project's session terminals and the action that closes them all. */
export function useSessionTerminals(): SessionTerminals {
  const count = useAgentSessionCatalog(
    (state) => sessionTerminalPtyIds(state).size,
  );
  const agentsBusy = useAgentSessionCatalog(sessionTerminalAgentsBusy);
  const closeAllTerminals = useAgentSessionCatalog(
    (state) => state.closeAllTerminals,
  );
  const closeAll = useCallback(
    () =>
      closeAllTerminals().catch((error: unknown) => {
        toast.error(m.sessions_toast_close_terminal_failed(), {
          description: getNativeErrorMessage(error),
        });
      }),
    [closeAllTerminals],
  );
  return { count, agentsBusy, closeAll };
}
