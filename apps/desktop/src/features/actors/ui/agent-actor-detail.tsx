import type { ChatAgents } from "@/features/agent-sessions/agent-settings-popover";

import { useAgentActorBinding } from "../hooks/use-agent-actor-binding";
import type {
  AgentActorAgentOption,
  AgentActorDraft,
} from "../model/agent-actor-types";
import { AgentActorForm } from "./agent-actor-form";
import { AgentActorReadOnlyDetail } from "./agent-actor-read-only-detail";

interface AgentActorDetailProps {
  agents: readonly AgentActorAgentOption[];
  draft: AgentActorDraft;
  editMode: boolean;
  /** How the chat offers the agents; null while they are read. */
  offers: ChatAgents | null;
  onChange(draft: AgentActorDraft): void;
  onOpenAgentSettings(): void;
  onRecheckOffers(): void;
  /** Saves the draft as the catalog takes it. */
  onSave(draft: AgentActorDraft): void;
}

export function AgentActorDetail(props: AgentActorDetailProps) {
  if (!props.editMode) {
    return (
      <AgentActorReadOnlyDetail
        agents={props.agents}
        draft={props.draft}
        offers={props.offers}
        onOpenAgentSettings={props.onOpenAgentSettings}
        onRecheckOffers={props.onRecheckOffers}
      />
    );
  }
  return <AgentActorEditForm {...props} />;
}

/**
 * The edit form of an Agent: while it is open the binding's agent runs its
 * draft session in the Space of the Actor's catalog, released once the
 * form closes.
 */
function AgentActorEditForm({
  agents,
  draft,
  offers,
  onChange,
  onOpenAgentSettings,
  onRecheckOffers,
  onSave,
}: AgentActorDetailProps) {
  const binding = useAgentActorBinding({
    agents,
    cwd: draft.ownerPath,
    draft,
    editable: true,
    offers,
    onChange,
    onRecheck: onRecheckOffers,
  });
  return (
    <AgentActorForm
      binding={binding}
      draft={draft}
      formId={`agent-actor-detail-${draft.id ?? "new"}`}
      onChange={onChange}
      onOpenAgentSettings={onOpenAgentSettings}
      onSubmit={() => onSave(binding.forSave(draft))}
    />
  );
}
