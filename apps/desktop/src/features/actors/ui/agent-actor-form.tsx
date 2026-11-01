import { Alert, AlertDescription } from "@/components/ui/alert";
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

import {
  bindingAgent,
  validateAgentActorDraft,
  withBindingAgent,
} from "../model/agent-actor-draft";
import type { AgentActorDraftValidation } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDiagnostic,
  AgentActorAgentOption,
  AgentActorDraft,
  AgentAdapterId,
} from "../model/agent-actor-types";

import { agentActorBindingLabel } from "./agent-actor-copy";
import { AgentAdapterCard } from "./agent-adapter-card";

export type AgentActorFormSection = "identity" | "adapters";

const ALL_SECTIONS: readonly AgentActorFormSection[] = ["identity", "adapters"];
/** The Select value of a binding that is not one of the offered agents. */
const CURRENT_BINDING = "__current_binding__";

export function AgentActorForm({
  agents,
  diagnostics,
  draft,
  formId,
  pendingAdapter,
  readOnly = false,
  sections = ALL_SECTIONS,
  showValidation = true,
  validation,
  onChange,
  onCheck,
  onSubmit,
  validateOnSubmit = true,
}: {
  agents: readonly AgentActorAgentOption[];
  diagnostics: Readonly<
    Partial<Record<AgentAdapterId, AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  formId: string;
  pendingAdapter: AgentAdapterId | null;
  readOnly?: boolean;
  sections?: readonly AgentActorFormSection[];
  showValidation?: boolean;
  validation?: AgentActorDraftValidation;
  onChange(draft: AgentActorDraft): void;
  onCheck(adapter: AgentAdapterId): void;
  onSubmit(): void;
  validateOnSubmit?: boolean;
}) {
  const errors = validation ?? validateAgentActorDraft(draft);
  const agent = bindingAgent(draft.binding);
  const offered =
    agent !== null && agents.some((option) => option.id === agent);
  const label = agentActorBindingLabel(draft.binding, agents);

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

      {sections.includes("adapters") ? (
        <FieldSet
          data-agent-actor-focus="adapters"
          data-invalid={showValidation && Boolean(errors.binding)}
          tabIndex={-1}
        >
          {sections.length > 1 ? (
            <FieldLegend>{m.agent_actors_agent_label()}</FieldLegend>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${formId}-agent`}>
              {m.agent_actors_agent_label()}
            </FieldLabel>
            <Select
              disabled={readOnly}
              value={agent !== null && offered ? agent : CURRENT_BINDING}
              onValueChange={(value) => {
                if (value !== CURRENT_BINDING) {
                  onChange(withBindingAgent(draft, value));
                }
              }}
            >
              <SelectTrigger id={`${formId}-agent`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {offered ? null : (
                    <SelectItem value={CURRENT_BINDING} disabled>
                      {label}
                    </SelectItem>
                  )}
                  {agents.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {agent !== null && offered ? (
            <AgentAdapterCard
              agent={agent}
              checkDisabled={pendingAdapter !== null}
              diagnostic={diagnostics[agent]}
              label={label}
              pending={pendingAdapter === agent}
              readOnly={readOnly}
              onCheck={() => onCheck(agent)}
            />
          ) : agent !== null ? (
            <Alert variant="destructive" data-agent-adapter-unknown>
              <AlertDescription>
                {m.agent_actors_adapter_unknown()}
              </AlertDescription>
            </Alert>
          ) : null}
          {showValidation && errors.binding ? (
            <FieldError>{m.agent_actors_binding_required()}</FieldError>
          ) : null}
        </FieldSet>
      ) : null}
    </form>
  );
}
