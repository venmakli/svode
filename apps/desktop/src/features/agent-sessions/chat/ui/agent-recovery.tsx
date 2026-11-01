import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentLaunchUnavailableDto } from "../api/chat";
import type { DraftAgentState } from "../hooks/use-draft-agent";
import * as m from "@/paraglide/messages.js";

/** The A1 outcome of an agent that cannot start, in the words of the agent settings. */
export function unavailableText(reason: AgentLaunchUnavailableDto): string {
  switch (reason.code) {
    case "node_missing":
      return m.settings_agents_state_node_missing({
        required: String(reason.required),
      });
    case "node_unsupported":
      return m.settings_agents_state_node_unsupported({
        version: reason.version,
        required: String(reason.required),
      });
    case "node_unknown":
      return m.settings_agents_state_node_unknown();
    case "cli_unsupported":
      return m.settings_agents_state_cli_unsupported({
        minimum: reason.minimum,
      });
    case "adapter_not_installed":
      return m.settings_agents_state_adapter_missing();
    case "adapter_needs_update":
      return m.sessions_chat_agent_adapter_outdated();
    case "executable_missing":
      return m.settings_agents_state_command_missing({
        command: reason.executable,
      });
    case "disabled":
      return m.settings_agents_state_disabled();
    case "not_supported":
      return m.settings_agents_state_deferred();
  }
}

export interface AgentRecoveryActions {
  onSignIn: (() => void) | null;
  onOpenSettings: () => void;
  onRetry: () => void;
}

export function AgentRecovery({
  readiness,
  recovery,
}: {
  readiness: Exclude<
    DraftAgentState,
    { state: "idle" } | { state: "connecting" }
  >;
  recovery: AgentRecoveryActions;
}) {
  let text: string;
  let signIn = false;
  let retry = false;
  if (readiness.state === "failed") {
    text = m.settings_agents_state_failed_to_start({
      message: readiness.message,
    });
    retry = true;
  } else {
    const check = readiness.check;
    switch (check.state) {
      case "auth_required":
        text = m.settings_agents_state_sign_in();
        signIn = true;
        break;
      case "unavailable":
        text = unavailableText(check.reason);
        break;
      case "failed_to_start":
        text = m.settings_agents_state_failed_to_start({
          message: check.message,
        });
        retry = true;
        break;
      case "ready":
        return null;
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm break-words">{text}</p>
      <div className="flex flex-wrap gap-2">
        {signIn && recovery.onSignIn && (
          <Button size="sm" onClick={recovery.onSignIn}>
            {m.settings_agents_action_sign_in()}
          </Button>
        )}
        {retry && (
          <Button size="sm" variant="outline" onClick={recovery.onRetry}>
            <RotateCw data-icon="inline-start" />
            {m.sessions_chat_agent_retry()}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={recovery.onOpenSettings}>
          {m.sessions_chat_agent_open_settings()}
        </Button>
      </div>
    </div>
  );
}
