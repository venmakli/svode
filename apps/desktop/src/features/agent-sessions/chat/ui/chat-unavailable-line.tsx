import { Info } from "lucide-react";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import type { ChatUnavailableReason } from "../model/interface";
import { unavailableText } from "./agent-button";
import * as m from "@/paraglide/messages.js";

/**
 * Why a session opened in its terminal rather than the chat (Stage 10
 * `04`, chat and terminal); an agent that cannot start leads to the agent
 * settings.
 */
export function ChatUnavailableLine({
  agent,
  reason,
  onOpenAgentSettings,
}: {
  agent: string;
  reason: ChatUnavailableReason;
  onOpenAgentSettings?: () => void;
}) {
  const dictionary = useAgentAdapterDictionary();
  let text: string;
  switch (reason.kind) {
    case "not_openable":
      text = m.sessions_chat_unavailable_not_openable();
      break;
    case "continues_in_ide":
      text = m.sessions_chat_unavailable_continues_in_ide({
        agent: dictionary.label(agent),
      });
      break;
    case "unsupported":
      text = m.sessions_chat_unsupported_title();
      break;
    case "agent_unavailable":
      text = m.sessions_chat_unavailable_agent({
        agent: dictionary.label(agent),
        reason: unavailableText(reason.reason),
      });
      break;
  }
  return (
    <Marker variant="border">
      <MarkerIcon>
        <Info />
      </MarkerIcon>
      <MarkerContent>{text}</MarkerContent>
      {reason.kind === "agent_unavailable" && onOpenAgentSettings && (
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto"
          onClick={onOpenAgentSettings}
        >
          {m.sessions_chat_agent_open_settings()}
        </Button>
      )}
    </Marker>
  );
}
