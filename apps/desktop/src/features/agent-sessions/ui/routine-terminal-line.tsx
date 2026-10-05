import { Info } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import type { RoutineTerminalChoice } from "@/features/routines/catalog";
import * as m from "@/paraglide/messages.js";

/**
 * Why the Routine that launched a session runs it in the terminal rather
 * than the chat (Stage 10 `04`, chat and terminal), with the agent's or
 * connection's own text behind the reason.
 */
export function RoutineTerminalLine({
  reason,
  detail,
}: {
  reason: RoutineTerminalChoice;
  detail: string | null;
}) {
  return (
    <Marker variant="border">
      <MarkerIcon>
        <Info />
      </MarkerIcon>
      <MarkerContent className="flex flex-col">
        <span>{reasonText(reason)}</span>
        {detail && (
          <span className="line-clamp-2 text-xs" title={detail}>
            {detail}
          </span>
        )}
      </MarkerContent>
    </Marker>
  );
}

function reasonText(reason: RoutineTerminalChoice) {
  switch (reason) {
    case "chat_unavailable":
      return m.sessions_routine_terminal_chat_unavailable();
    case "binding_not_acp":
      return m.sessions_routine_terminal_binding_not_acp();
    case "acp_failed_before_prompt":
      return m.sessions_routine_terminal_acp_failed();
  }
}
