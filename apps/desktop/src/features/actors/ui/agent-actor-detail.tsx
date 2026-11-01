import type {
  AgentActorAdapterDiagnostic,
  AgentActorAgentOption,
  AgentActorDraft,
  AgentAdapterId,
} from "../model/agent-actor-types";
import { AgentActorForm } from "./agent-actor-form";
import { AgentActorReadOnlyDetail } from "./agent-actor-read-only-detail";

export function AgentActorDetail({
  agents,
  diagnostics,
  draft,
  editMode,
  pendingAdapter,
  onChange,
  onCheck,
  onSave,
}: {
  agents: readonly AgentActorAgentOption[];
  diagnostics: Readonly<
    Partial<Record<AgentAdapterId, AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  editMode: boolean;
  pendingAdapter: AgentAdapterId | null;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentAdapterId): void;
  onSave(): void;
}) {
  if (!editMode) {
    return (
      <AgentActorReadOnlyDetail
        agents={agents}
        diagnostics={diagnostics}
        draft={draft}
        pendingAdapter={pendingAdapter}
        onCheck={onCheck}
      />
    );
  }

  return (
    <AgentActorForm
      agents={agents}
      diagnostics={diagnostics}
      draft={draft}
      formId={`agent-actor-detail-${draft.id ?? "new"}`}
      pendingAdapter={pendingAdapter}
      onChange={onChange}
      onCheck={onCheck}
      onSubmit={onSave}
    />
  );
}
