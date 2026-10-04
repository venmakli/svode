import { ChevronDown, RotateCw, Settings2 } from "lucide-react";
import { useState } from "react";
import { AgentIcon, useAgentAdapterDictionary } from "@/features/agent-adapters";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InputGroupButton } from "@/components/ui/input-group";
import type { AgentLaunchUnavailableDto } from "../api/chat";
import type { ChatAgent } from "../model/agents";
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

/**
 * The agent of a new session draft (Stage 10 `04`, composer): one button in
 * the field with a popover of agent tabs, the agent's readiness under
 * "Model" while it starts or when it needs recovery, and a link to the
 * agent settings.
 */
export function DraftAgentButton({
  agents,
  agent,
  readiness,
  onChoose,
  recovery,
}: {
  agents: ChatAgent[];
  agent: string | null;
  readiness: DraftAgentState;
  onChoose: (agent: string) => void;
  recovery: AgentRecoveryActions;
}) {
  const dictionary = useAgentAdapterDictionary();
  const [open, setOpen] = useState(false);
  const label = agent ? dictionary.label(agent) : m.sessions_chat_agent_choose();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InputGroupButton
          size="sm"
          className="max-w-56 gap-1.5 px-2"
          aria-label={m.sessions_chat_agent_button({ agent: label })}
        >
          {agent && <AgentIcon agent={agent} />}
          <span className="truncate">{label}</span>
          <ChevronDown className="text-muted-foreground" />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-0 p-0">
        <div className="flex flex-col gap-3 p-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            value={agent ?? ""}
            onValueChange={(next) => {
              if (next) onChoose(next);
            }}
            aria-label={m.sessions_chat_agent_tabs()}
            className="flex-wrap justify-start"
          >
            {agents.map((candidate) => (
              <Tooltip key={candidate.agent}>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value={candidate.agent}
                    aria-label={candidate.name}
                    className="size-8 px-0"
                  >
                    <AgentIcon agent={candidate.agent} />
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent>{candidate.name}</TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
          <AgentReadinessBlock readiness={readiness} recovery={recovery} />
        </div>
        <div className="border-t p-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false);
              recovery.onOpenSettings();
            }}
          >
            <Settings2 data-icon="inline-start" />
            {m.sessions_chat_agent_settings()}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The "Model" block while the agent starts or when it needs recovery. The
 * models themselves come with the session settings of the agent.
 */
function AgentReadinessBlock({
  readiness,
  recovery,
}: {
  readiness: DraftAgentState;
  recovery: AgentRecoveryActions;
}) {
  if (readiness.state === "idle") return null;
  if (readiness.state === "checked" && readiness.check.state === "ready") {
    return null;
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">
        {m.sessions_chat_model()}
      </h3>
      {readiness.state === "connecting" ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-3/4" />
        </div>
      ) : (
        <AgentRecovery readiness={readiness} recovery={recovery} />
      )}
    </section>
  );
}

export function AgentRecovery({
  readiness,
  recovery,
}: {
  readiness: Exclude<DraftAgentState, { state: "idle" } | { state: "connecting" }>;
  recovery: AgentRecoveryActions;
}) {
  let text: string;
  let signIn = false;
  let retry = false;
  if (readiness.state === "failed") {
    text = m.settings_agents_state_failed_to_start({ message: readiness.message });
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

/** The agent of an existing session: it does not change. */
export function SessionAgentLabel({ agent }: { agent: string }) {
  const dictionary = useAgentAdapterDictionary();
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">
      <AgentIcon agent={agent} />
      <span className="truncate">{dictionary.label(agent)}</span>
    </span>
  );
}
