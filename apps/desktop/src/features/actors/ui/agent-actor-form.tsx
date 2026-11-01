import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import * as m from "@/paraglide/messages.js";

import type { AgentActorBindingEditor } from "../hooks/use-agent-actor-binding";
import { validateAgentActorDraft } from "../model/agent-actor-draft";
import type { AgentActorDraftValidation } from "../model/agent-actor-draft";
import type { AgentActorDraft } from "../model/agent-actor-types";
import { AgentActorBindingField } from "./agent-actor-binding-field";

export type AgentActorFormSection = "identity" | "agent";

const ALL_SECTIONS: readonly AgentActorFormSection[] = ["identity", "agent"];

export function AgentActorForm({
  binding,
  draft,
  formId,
  readOnly = false,
  sections = ALL_SECTIONS,
  showValidation = true,
  validation,
  onChange,
  onOpenAgentSettings,
  onSubmit,
  validateOnSubmit = true,
}: {
  binding: AgentActorBindingEditor;
  draft: AgentActorDraft;
  formId: string;
  readOnly?: boolean;
  sections?: readonly AgentActorFormSection[];
  showValidation?: boolean;
  validation?: AgentActorDraftValidation;
  onChange(draft: AgentActorDraft): void;
  onOpenAgentSettings(): void;
  onSubmit(): void;
  validateOnSubmit?: boolean;
}) {
  const errors = validation ?? validateAgentActorDraft(draft);

  return (
    <form
      id={formId}
      className="flex min-h-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (readOnly) return;
        if (!validateOnSubmit || (!errors.name && !errors.binding)) onSubmit();
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
              readOnly={readOnly}
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
              readOnly={readOnly}
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

      {sections.includes("agent") ? (
        <Field data-invalid={showValidation && Boolean(errors.binding)}>
          <FieldLabel htmlFor={`${formId}-agent`}>
            {m.agent_actors_agent_label()}
          </FieldLabel>
          <AgentActorBindingField
            binding={binding}
            id={`${formId}-agent`}
            invalid={showValidation && Boolean(errors.binding)}
            onOpenAgentSettings={onOpenAgentSettings}
          />
          {showValidation && errors.binding ? (
            <FieldError>{m.agent_actors_binding_required()}</FieldError>
          ) : null}
        </Field>
      ) : null}
    </form>
  );
}
