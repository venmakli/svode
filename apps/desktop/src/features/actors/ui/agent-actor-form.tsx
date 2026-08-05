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
import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorApprovalMapping,
  AgentActorBinding,
  AgentActorBindingValidation,
  AgentActorDraft,
  AgentActorSelectOption,
} from "../model/agent-actor-types";

import { AgentAdapterCard } from "./agent-adapter-card";

export function AgentActorForm({
  approvalMappings,
  descriptors,
  diagnostics,
  draft,
  effortOptions,
  formId,
  pendingAdapter,
  readOnly = false,
  validations,
  onChange,
  onCheck,
  onSubmit,
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
  formId: string;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  readOnly?: boolean;
  validations: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorBindingValidation>>
  >;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentActorBinding["adapter"]): void;
  onSubmit(): void;
}) {
  const errors = validateAgentActorDraft(draft);
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
        if (!errors.name && !errors.adapters) onSubmit();
      }}
    >
      {!readOnly ? (
        <FieldGroup>
          <Field data-invalid={Boolean(errors.name)}>
            <FieldLabel htmlFor={`${formId}-name`}>
              {m.agent_actors_name_label()}
            </FieldLabel>
            <Input
              id={`${formId}-name`}
              value={draft.name}
              aria-invalid={Boolean(errors.name)}
              autoFocus
              onChange={(event) =>
                onChange({ ...draft, name: event.target.value })
              }
            />
            {errors.name ? (
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

      <Field>
        <FieldLabel>{m.agent_actors_approval_label()}</FieldLabel>
        {readOnly ? (
          <span className="text-sm">{approvalLabel(draft.approvalMode)}</span>
        ) : (
          <Select
            value={draft.approvalMode}
            onValueChange={(value) =>
              onChange({
                ...draft,
                approvalMode: value as AgentActorDraft["approvalMode"],
              })
            }
          >
            <SelectTrigger className="w-full">
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
        )}
        <FieldDescription>
          {approvalDescription(draft.approvalMode)}
        </FieldDescription>
      </Field>

      {draft.approvalMode === "full" ? (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>{m.agent_actors_full_warning_title()}</AlertTitle>
          <AlertDescription>{m.agent_actors_full_warning()}</AlertDescription>
        </Alert>
      ) : null}

      <FieldSet data-invalid={Boolean(errors.adapters)}>
        <FieldLegend>{m.agent_actors_adapters_title()}</FieldLegend>
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
                descriptor={descriptor}
                diagnostic={diagnostics[binding.adapter]}
                effortOptions={effortOptions[binding.adapter] ?? []}
                canRemove={draft.adapters.length > 1}
                pending={pendingAdapter === binding.adapter}
                primary={index === 0}
                readOnly={readOnly}
                validation={validations[binding.adapter]}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    adapters: draft.adapters.map((candidate, candidateIndex) =>
                      candidateIndex === index ? next : candidate,
                    ),
                  })
                }
                onCheck={() => onCheck(binding.adapter)}
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
                onRemove={() =>
                  onChange({
                    ...draft,
                    adapters: draft.adapters.filter(
                      (_, candidateIndex) => candidateIndex !== index,
                    ),
                  })
                }
              />
            );
          })}
        </div>
        {errors.adapters ? (
          <FieldError>{m.agent_actors_binding_required()}</FieldError>
        ) : null}
        {!readOnly && available.length > 0 ? (
          <Select
            value=""
            onValueChange={(value) =>
              onChange({
                ...draft,
                adapters: [
                  ...draft.adapters,
                  {
                    adapter: value as AgentActorBinding["adapter"],
                    effort: null,
                    model: null,
                  },
                ],
              })
            }
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
    </form>
  );
}

function approvalLabel(mode: AgentActorDraft["approvalMode"]) {
  if (mode === "auto") return m.agent_actors_approval_auto();
  if (mode === "full") return m.agent_actors_approval_full();
  return m.agent_actors_approval_ask();
}

function approvalDescription(mode: AgentActorDraft["approvalMode"]) {
  if (mode === "auto") return m.agent_actors_approval_auto_hint();
  if (mode === "full") return m.agent_actors_approval_full_hint();
  return m.agent_actors_approval_ask_hint();
}
