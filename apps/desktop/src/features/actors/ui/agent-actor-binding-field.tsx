import { useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  AgentSettingsPopover,
  AgentSettingsSummary,
  declaredSettings,
  useAgentSettingsSummary,
  useDefaultAgent,
  useLastAgentDeclarations,
} from "@/features/agent-sessions/agent-settings-popover";
import { AgentSignInDialog } from "@/features/settings/agent-sign-in";
import * as m from "@/paraglide/messages.js";

import type { AgentActorBindingEditor } from "../hooks/use-agent-actor-binding";

/**
 * The binding row of an Actor's form (Stage 11 `03`, host "Actor
 * binding"): the agent's icon, model and in gray its reasoning, the
 * participant's agent, or "Choose an agent"; it opens the agent settings
 * popover, where choosing a tab changes the binding's agent and keeps the
 * popover open, the mode is the last row under the agent's own label and
 * "Configure agents…" leads to the agent settings.
 */
export function AgentActorBindingField({
  binding,
  id,
  invalid = false,
  onOpenAgentSettings,
}: {
  binding: AgentActorBindingEditor;
  id?: string;
  invalid?: boolean;
  onOpenAgentSettings(): void;
}) {
  const dictionary = useAgentAdapterDictionary();
  const [open, setOpen] = useState(false);
  const summary = useAgentSettingsSummary(
    binding.agent,
    binding.summarySettings,
    m.agent_actors_agent_choose(),
  );
  const leave = () => {
    setOpen(false);
    onOpenAgentSettings();
  };
  return (
    <>
      <AgentSettingsPopover
        side="bottom"
        align="start"
        open={open}
        onOpenChange={setOpen}
        agent={binding.agent}
        choice={{
          ...binding.choice(leave),
          onChoose: binding.chooseAgent,
        }}
        extraTab={
          binding.editable || binding.participant
            ? {
                label: m.agent_actors_participant_agent(),
                icon: <UsersRound />,
                selected: binding.participant,
                onChoose: binding.chooseParticipant,
                content: <ParticipantAgentContent onChoose={leave} />,
              }
            : undefined
        }
        settings={binding.settings}
        modeRow
        canChange={binding.canChange}
        changing={binding.changing}
        onChange={binding.changeSetting}
        onConfigureAgents={onOpenAgentSettings}
        trigger={
          <Button
            id={id}
            type="button"
            variant="outline"
            className="w-full min-w-0 justify-start gap-1.5"
            aria-invalid={invalid || undefined}
            aria-label={
              binding.participant
                ? m.agent_actors_participant_agent()
                : summary.text
            }
            data-agent-actor-focus="agent"
            data-agent-actor-binding
          >
            <AgentActorBindingSummary binding={binding} />
            <ChevronDown className="ml-auto text-muted-foreground" />
          </Button>
        }
      />
      {binding.agent !== null && !binding.known ? (
        <p className="text-sm text-muted-foreground" data-agent-adapter-unknown>
          {m.agent_actors_adapter_unknown()}
        </p>
      ) : null}
      {binding.signIn ? (
        <AgentSignInDialog
          agent={dictionary.label(binding.signIn.agent)}
          ptyId={binding.signIn.ptyId}
          onSignedIn={binding.recheck}
          onClose={binding.endSignIn}
        />
      ) : null}
    </>
  );
}

/**
 * What the binding row names: the agent with its model and reasoning, the
 * participant's agent, or "Choose an agent".
 */
export function AgentActorBindingSummary({
  binding,
}: {
  binding: AgentActorBindingEditor;
}) {
  if (binding.participant) {
    return (
      <>
        <UsersRound />
        <span className="truncate">{m.agent_actors_participant_agent()}</span>
      </>
    );
  }
  if (binding.agent === null) {
    return (
      <span className="truncate text-muted-foreground">
        {m.agent_actors_agent_choose()}
      </span>
    );
  }
  if (!binding.known) {
    return <span className="truncate">{binding.agent}</span>;
  }
  return (
    <AgentSettingsSummary
      agent={binding.agent}
      settings={binding.summarySettings}
      empty={m.agent_actors_agent_choose()}
    />
  );
}

/**
 * The tab of the participant's agent: each member runs the Actor with the
 * default agent of their device; this device's one, or the way to choose it.
 */
function ParticipantAgentContent({ onChoose }: { onChoose(): void }) {
  const { value, loaded } = useDefaultAgent();
  const agent = value?.agent ?? null;
  const declarations = useLastAgentDeclarations(agent, agent !== null);
  const settings =
    value && declarations
      ? declaredSettings({
          session: null,
          declarations,
          values: value.settings,
        }).settings
      : null;
  return (
    <div className="flex flex-col gap-2 p-2" data-agent-actor-participant>
      <p className="text-sm text-muted-foreground">
        {m.agent_actors_participant_explanation()}
      </p>
      {!loaded ? (
        <Skeleton className="h-7 w-3/4" />
      ) : agent ? (
        <div className="flex h-7 min-w-0 items-center gap-2 text-sm">
          <AgentSettingsSummary agent={agent} settings={settings} empty="" />
        </div>
      ) : (
        <>
          <p className="text-sm">{m.agent_actors_participant_no_default()}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={onChoose}
          >
            {m.agent_actors_participant_choose_in_settings()}
          </Button>
        </>
      )}
    </div>
  );
}
