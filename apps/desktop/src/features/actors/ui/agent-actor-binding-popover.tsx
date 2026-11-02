import { UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  AgentSettingsPopover,
  AgentSettingsSummary,
  declaredSettings,
  useDefaultAgent,
  useLastAgentDeclarations,
  type ChatAgents,
} from "@/features/agent-sessions/agent-settings-popover";
import type { CollectionPropertyOwnPopoverEditorInput } from "@/features/properties";
import { AgentSignInDialog } from "@/features/settings/agent-sign-in";
import * as m from "@/paraglide/messages.js";

import { useAgentActorBinding } from "../hooks/use-agent-actor-binding";
import { agentActorBindingEdit } from "../model/agent-actor-draft";
import type {
  AgentActorAgentOption,
  AgentActorBindingEdit,
  AgentActorItem,
} from "../model/agent-actor-types";

/**
 * The popover of an Agent's "Agent" and "Approval mode" (Stage 11 `03`,
 * host "Actor binding"; `04`, 4.I): it opens from the property's value.
 * Choosing a tab changes the agent of the draft binding and keeps the
 * popover open, the mode is the last row under the agent's own label and
 * "Configure agents…" leads to the agent settings. While it is open the
 * agent's draft session runs in the Space of the Agent's catalog; closing
 * the popover releases it and saves the draft whole.
 */
export function AgentActorBindingPopover({
  agents,
  input,
  offers,
  opensOnMode = false,
  onOpenAgentSettings,
  onRecheckOffers,
}: {
  agents: readonly AgentActorAgentOption[];
  input: CollectionPropertyOwnPopoverEditorInput<AgentActorItem>;
  /** How the chat offers the agents; null while they are read. */
  offers: ChatAgents | null;
  /** Opens on the screen of the mode's values, as "Approval mode" does. */
  opensOnMode?: boolean;
  onOpenAgentSettings(): void;
  onRecheckOffers(): void;
}) {
  const dictionary = useAgentAdapterDictionary();
  const { item, open } = input;
  const draft =
    open && input.draft
      ? (input.draft as AgentActorBindingEdit)
      : agentActorBindingEdit(item);
  const binding = useAgentActorBinding({
    agents,
    cwd: open ? item.ownerPath : null,
    draft,
    editable: true,
    offers,
    onChange: input.onDraftChange,
    onRecheck: onRecheckOffers,
  });
  const leave = () => {
    input.onOpenChange(false);
    onOpenAgentSettings();
  };
  return (
    <>
      <AgentSettingsPopover
        side="bottom"
        align="start"
        open={open}
        onOpenChange={input.onOpenChange}
        onEscapeKeyDown={input.onEscapeKeyDown}
        opensOnMode={opensOnMode}
        agent={binding.agent}
        choice={{
          ...binding.choice(leave),
          onChoose: binding.chooseAgent,
        }}
        extraTab={{
          label: m.agent_actors_participant_agent(),
          icon: <UsersRound />,
          selected: binding.participant,
          onChoose: binding.chooseParticipant,
          content: <ParticipantAgentContent onChoose={leave} />,
        }}
        settings={binding.settings}
        modeRow
        canChange={binding.canChange}
        changing={binding.changing}
        onChange={binding.changeSetting}
        onConfigureAgents={onOpenAgentSettings}
        trigger={input.trigger}
      />
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
