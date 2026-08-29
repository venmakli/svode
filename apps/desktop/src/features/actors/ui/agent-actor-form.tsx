import { ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import * as m from "@/paraglide/messages.js";

import { validateAgentActorDraft } from "../model/agent-actor-draft";
import type { AgentActorDraftValidation } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorApprovalMapping,
  AgentActorBinding,
  AgentActorBindingValidation,
  AgentActorDraft,
  AgentActorSelectOption,
} from "../model/agent-actor-types";

import {
  agentActorApprovalDescription,
  agentActorApprovalLabel,
  agentActorEffectiveBoundary,
} from "./agent-actor-copy";
import { AgentAdapterCard } from "./agent-adapter-card";

export type AgentActorFormSection = "identity" | "adapters" | "permissions";

const ALL_SECTIONS: readonly AgentActorFormSection[] = [
  "identity",
  "adapters",
  "permissions",
];

export function AgentActorForm({
  approvalMappings,
  descriptors,
  diagnostics,
  draft,
  effortOptions,
  expandedAdapter,
  formId,
  pendingAdapter,
  sections = ALL_SECTIONS,
  showValidation = true,
  validation,
  validations,
  onChange,
  onCheck,
  onExpandedAdapterChange,
  onSubmit,
  validateOnSubmit = true,
}: {
  approvalMappings: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorApprovalMapping>>
  >;
  descriptors: readonly AgentActorAdapterDescriptor[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  effortOptions: Readonly<
    Partial<
      Record<AgentActorBinding["adapter"], readonly AgentActorSelectOption[]>
    >
  >;
  expandedAdapter?: AgentActorBinding["adapter"] | null;
  formId: string;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  sections?: readonly AgentActorFormSection[];
  showValidation?: boolean;
  validation?: AgentActorDraftValidation;
  validations: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorBindingValidation>>
  >;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentActorBinding["adapter"]): void;
  onExpandedAdapterChange?(adapter: AgentActorBinding["adapter"] | null): void;
  onSubmit(): void;
  validateOnSubmit?: boolean;
}) {
  const errors = validation ?? validateAgentActorDraft(draft);
  const configured = new Set(draft.adapters.map((binding) => binding.adapter));
  const available = descriptors.filter(
    (descriptor) => !configured.has(descriptor.id),
  );

  return (
    <form
      id={formId}
      className="flex min-h-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!validateOnSubmit || (!errors.name && !errors.adapters)) onSubmit();
      }}
    >
      {sections.includes("identity") ? (
        <FieldGroup>
          <Field data-invalid={showValidation && Boolean(errors.name)}>
            <FieldLabel htmlFor={`${formId}-name`}>
              {m.agent_actors_name_label()}
            </FieldLabel>
            <Input
              id={`${formId}-name`}
              data-agent-actor-focus="identity"
              value={draft.name}
              aria-invalid={showValidation && Boolean(errors.name)}
              autoFocus
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
            />
            {showValidation && errors.name ? (
              <FieldError>{m.agent_actors_name_required()}</FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-description`}>
              {m.agent_actors_description_label()}
            </FieldLabel>
            <Textarea
              id={`${formId}-description`}
              value={draft.description}
              onChange={(event) =>
                onChange({ ...draft, description: event.target.value })
              }
            />
            <FieldDescription>
              {m.agent_actors_description_hint()}
            </FieldDescription>
          </Field>
        </FieldGroup>
      ) : null}

      {sections.includes("permissions") ? (
        <>
          <Field
            data-invalid={
              showValidation &&
              !sections.includes("adapters") &&
              Boolean(errors.adapters)
            }
          >
            <FieldLabel>{m.agent_actors_approval_label()}</FieldLabel>
            <Select
              value={draft.approvalMode}
              onValueChange={(value) =>
                onChange({
                  ...draft,
                  approvalMode: value as AgentActorDraft["approvalMode"],
                })
              }
            >
              <SelectTrigger
                className="w-full"
                data-agent-actor-focus="permissions"
                aria-invalid={
                  showValidation &&
                  !sections.includes("adapters") &&
                  Boolean(errors.adapters)
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ask">
                    {m.agent_actors_approval_ask()}
                  </SelectItem>
                  <SelectItem value="auto">
                    {m.agent_actors_approval_auto()}
                  </SelectItem>
                  <SelectItem value="full">
                    {m.agent_actors_approval_full()}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {agentActorApprovalDescription(draft.approvalMode)}
            </FieldDescription>
            {showValidation &&
            !sections.includes("adapters") &&
            errors.adapters ? (
              <FieldError>{adapterErrorMessage(errors.adapters)}</FieldError>
            ) : null}
          </Field>

          <div className="grid gap-2" aria-live="polite">
            <p className="text-sm font-medium">
              {m.agent_actors_permissions_boundaries_title()}
            </p>
            <dl className="grid gap-2">
              {draft.adapters.map((binding) => {
                const descriptor = descriptors.find(
                  (candidate) => candidate.id === binding.adapter,
                );
                const mapping = approvalMappings[binding.adapter];
                return (
                  <div
                    key={binding.adapter}
                    className="bg-muted/40 rounded-md border px-3 py-2"
                  >
                    <dt className="text-sm font-medium">
                      {descriptor?.label ?? binding.adapter}
                    </dt>
                    <dd className="text-muted-foreground text-sm">
                      {mapping
                        ? `${agentActorApprovalLabel(mapping.requested)}: ${agentActorEffectiveBoundary(mapping.native)}`
                        : m.agent_actors_binding_checking()}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>

          {draft.approvalMode === "full" ? (
            <Alert variant="destructive">
              <ShieldAlert />
              <AlertTitle>{m.agent_actors_full_warning_title()}</AlertTitle>
              <AlertDescription>
                {m.agent_actors_full_warning()}
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : null}

      {sections.includes("adapters") ? (
        <FieldSet
          data-agent-actor-focus="adapters"
          data-invalid={showValidation && Boolean(errors.adapters)}
          tabIndex={-1}
        >
          {sections.length > 1 ? (
            <FieldLegend>{m.agent_actors_adapters_title()}</FieldLegend>
          ) : null}
          <FieldDescription>{m.agent_actors_adapters_hint()}</FieldDescription>
          <div className="flex flex-col gap-3">
            {draft.adapters.map((binding, index) => {
              const descriptor = descriptors.find(
                (candidate) => candidate.id === binding.adapter,
              );
              return (
                <AgentAdapterCard
                  key={binding.adapter}
                  approvalMapping={approvalMappings[binding.adapter]}
                  binding={binding}
                  checkDisabled={pendingAdapter !== null}
                  descriptor={descriptor}
                  diagnostic={diagnostics[binding.adapter]}
                  effortOptions={effortOptions[binding.adapter] ?? []}
                  open={
                    expandedAdapter === undefined
                      ? undefined
                      : expandedAdapter === binding.adapter
                  }
                  canRemove={draft.adapters.length > 1}
                  pending={pendingAdapter === binding.adapter}
                  primary={index === 0}
                  validation={validations[binding.adapter]}
                  onChange={(next) =>
                    onChange({
                      ...draft,
                      adapters: draft.adapters.map(
                        (candidate, candidateIndex) =>
                          candidateIndex === index ? next : candidate,
                      ),
                    })
                  }
                  onCheck={() => onCheck(binding.adapter)}
                  onOpenChange={(open) =>
                    onExpandedAdapterChange?.(open ? binding.adapter : null)
                  }
                  onMakePrimary={() =>
                    onChange({
                      ...draft,
                      adapters: [
                        binding,
                        ...draft.adapters.filter(
                          (_, candidateIndex) => candidateIndex !== index,
                        ),
                      ],
                    })
                  }
                  onRemove={() => {
                    const adapters = draft.adapters.filter(
                      (_, candidateIndex) => candidateIndex !== index,
                    );
                    onChange({
                      ...draft,
                      adapters,
                    });
                    if (expandedAdapter === binding.adapter) {
                      onExpandedAdapterChange?.(adapters[0]?.adapter ?? null);
                    }
                  }}
                />
              );
            })}
          </div>
          {showValidation && errors.adapters ? (
            <FieldError>{adapterErrorMessage(errors.adapters)}</FieldError>
          ) : null}
          {available.length > 0 ? (
            <Select
              value=""
              onValueChange={(value) => {
                const adapter = value as AgentActorBinding["adapter"];
                onChange({
                  ...draft,
                  adapters: [
                    ...draft.adapters,
                    {
                      adapter,
                      effort: null,
                      model: null,
                    },
                  ],
                });
                onExpandedAdapterChange?.(adapter);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={m.agent_actors_add_adapter()} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {available.map((descriptor) => (
                    <SelectItem key={descriptor.id} value={descriptor.id}>
                      {descriptor.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </FieldSet>
      ) : null}
    </form>
  );
}

function adapterErrorMessage(
  error: NonNullable<AgentActorDraftValidation["adapters"]>,
) {
  if (error === "binding_inspection_pending") {
    return m.agent_actors_binding_checking();
  }
  if (error === "binding_inspection_failed") {
    return m.agent_actors_binding_check_failed();
  }
  if (error === "binding_invalid") {
    return m.agent_actors_binding_invalid();
  }
  return m.agent_actors_binding_required();
}
