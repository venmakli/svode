import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";
import { AgentActorForm } from "./agent-actor-form";
import { AgentActorReadOnlyDetail } from "./agent-actor-read-only-detail";

export function AgentActorDetail({
  descriptors,
  diagnostics,
  draft,
  editMode,
  pendingAdapter,
  runtime,
  onChange,
  onCheck,
  onSave,
}: {
  descriptors: readonly AgentActorAdapterDescriptor[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  editMode: boolean;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentActorBinding["adapter"]): void;
  onSave(): void;
}) {
  if (!editMode) {
    return (
      <AgentActorReadOnlyDetail
        descriptors={descriptors}
        diagnostics={diagnostics}
        draft={draft}
        pendingAdapter={pendingAdapter}
        runtime={runtime}
        onCheck={onCheck}
      />
    );
  }

  return (
    <AgentActorForm
      approvalMappings={mapRuntime(runtime, "approval")}
      descriptors={descriptors}
      diagnostics={diagnostics}
      draft={draft}
      effortOptions={mapRuntime(runtime, "effortOptions")}
      formId={`agent-actor-detail-${draft.id ?? "new"}`}
      pendingAdapter={pendingAdapter}
      validations={mapRuntime(runtime, "validation")}
      onChange={onChange}
      onCheck={onCheck}
      onSubmit={onSave}
    />
  );
}

function mapRuntime<Key extends keyof AgentActorBindingRuntime>(
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >,
  key: Key,
): Partial<
  Record<AgentActorBinding["adapter"], AgentActorBindingRuntime[Key]>
> {
  return Object.fromEntries(
    Object.entries(runtime).map(([adapter, value]) => [adapter, value?.[key]]),
  );
}
