import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as m from "@/paraglide/messages.js";

import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";
import { AgentActorForm } from "./agent-actor-form";

export function AgentActorEditorDialog({
  descriptors,
  diagnostics,
  draft,
  failure,
  pending,
  pendingAdapter,
  runtime,
  onChange,
  onCheck,
  onClose,
  onSave,
}: {
  descriptors: readonly AgentActorAdapterDescriptor[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft | null;
  failure: string | null;
  pending: boolean;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentActorBinding["adapter"]): void;
  onClose(): void;
  onSave(): void;
}) {
  if (!draft) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.agent_actors_create_title()}</DialogTitle>
          <DialogDescription>
            {m.agent_actors_create_description()}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-1 py-1">
          <AgentActorForm
            approvalMappings={mapRuntime(runtime, "approval")}
            descriptors={descriptors}
            diagnostics={diagnostics}
            draft={draft}
            effortOptions={mapRuntime(runtime, "effortOptions")}
            formId="agent-actor-create-form"
            pendingAdapter={pendingAdapter}
            validations={mapRuntime(runtime, "validation")}
            onChange={onChange}
            onCheck={onCheck}
            onSubmit={onSave}
          />
        </div>
        {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            {m.agent_actors_cancel()}
          </Button>
          <Button
            type="submit"
            form="agent-actor-create-form"
            disabled={pending}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending
              ? m.agent_actors_saving()
              : m.agent_actors_create_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
