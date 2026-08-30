import { ChevronDown, LoaderCircle, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as m from "@/paraglide/messages.js";

import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorApprovalMapping,
  AgentActorBinding,
  AgentActorBindingValidation,
  AgentActorSelectOption,
} from "../model/agent-actor-types";
import {
  agentActorDiagnosticStatus,
  agentActorDiagnosticSummary,
  agentActorEffectiveBoundary,
  agentActorSelectorLabel,
  agentActorValidationIssueLabel,
} from "./agent-actor-copy";

const DEFAULT_VALUE = "__client_default__";

export function AgentAdapterCard({
  approvalMapping,
  binding,
  canRemove,
  checkDisabled,
  descriptor,
  diagnostic,
  effortOptions,
  open,
  pending,
  primary,
  readOnly,
  validation,
  onChange,
  onCheck,
  onOpenChange,
  onMakePrimary,
  onRemove,
}: {
  approvalMapping?: AgentActorApprovalMapping;
  binding: AgentActorBinding;
  canRemove: boolean;
  checkDisabled: boolean;
  descriptor?: AgentActorAdapterDescriptor;
  diagnostic?: AgentActorAdapterDiagnostic;
  effortOptions: readonly AgentActorSelectOption[];
  open?: boolean;
  pending: boolean;
  primary: boolean;
  readOnly: boolean;
  validation?: AgentActorBindingValidation;
  onChange(binding: AgentActorBinding): void;
  onCheck(): void;
  onOpenChange?(open: boolean): void;
  onMakePrimary(): void;
  onRemove(): void;
}) {
  return (
    <Collapsible
      defaultOpen={open === undefined ? true : undefined}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Card size="sm" data-agent-adapter={binding.adapter}>
        <CardHeader>
          <CardTitle className="flex min-w-0 items-center gap-2">
            <span>{descriptor?.label ?? binding.adapter}</span>
            <Badge variant={primary ? "default" : "secondary"}>
              {primary ? m.agent_actors_primary() : m.agent_actors_fallback()}
            </Badge>
          </CardTitle>
          <CardDescription className="truncate">
            {agentActorSelectorLabel(binding.model)}
            {" · "}
            {agentActorSelectorLabel(binding.effort)}
            {" · "}
            {agentActorDiagnosticStatus(diagnostic, pending)}
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={m.agent_actors_toggle_adapter()}
              >
                <ChevronDown />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-4">
            <FieldGroup>
              <AdapterSelectField
                label={m.agent_actors_model_label()}
                options={descriptor?.modelOptions ?? []}
                readOnly={readOnly}
                value={binding.model}
                onChange={(model) =>
                  onChange({ ...binding, effort: null, model })
                }
              />
              <AdapterSelectField
                label={m.agent_actors_effort_label()}
                options={effortOptions}
                readOnly={readOnly}
                value={binding.effort}
                onChange={(effort) => onChange({ ...binding, effort })}
              />
            </FieldGroup>
            {approvalMapping ? (
              <Alert
                variant={approvalMapping.danger ? "destructive" : "default"}
              >
                <AlertTitle>
                  {m.agent_actors_effective_boundary_label()}
                </AlertTitle>
                <AlertDescription>
                  {agentActorEffectiveBoundary(approvalMapping.native)}
                </AlertDescription>
              </Alert>
            ) : null}
            {validation?.issues.map((issue) => (
              <Alert key={`${issue.field}:${issue.code}`} variant="destructive">
                <AlertDescription>
                  {agentActorValidationIssueLabel(issue)}
                </AlertDescription>
              </Alert>
            ))}
            {agentActorDiagnosticSummary(diagnostic) ? (
              <Alert variant="destructive">
                <AlertTitle>
                  {agentActorDiagnosticSummary(diagnostic)}
                </AlertTitle>
                {diagnostic?.message ? (
                  <AlertDescription>
                    {m.agent_actors_diagnostic_raw_detail()}:{" "}
                    {diagnostic.message}
                  </AlertDescription>
                ) : null}
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checkDisabled || readOnly}
                onClick={onCheck}
              >
                {pending ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {m.agent_actors_check()}
              </Button>
              {!primary ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={onMakePrimary}
                >
                  {m.agent_actors_make_primary()}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={readOnly || !canRemove}
                onClick={onRemove}
              >
                <Trash2 data-icon="inline-start" />
                {m.agent_actors_remove_adapter()}
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function AdapterSelectField({
  label,
  onChange,
  options,
  readOnly,
  value,
}: {
  label: string;
  onChange(value: string | null): void;
  options: readonly AgentActorSelectOption[];
  readOnly: boolean;
  value: string | null;
}) {
  const known = options.some((option) => option.value === value);
  const effectiveOptions =
    !known && value ? [{ label: value, value }, ...options] : options;
  return (
    <Field data-invalid={!known && Boolean(value)}>
      <FieldLabel>{label}</FieldLabel>
      <Select
        disabled={readOnly}
        value={value ?? DEFAULT_VALUE}
        onValueChange={(next) => onChange(next === DEFAULT_VALUE ? null : next)}
      >
        <SelectTrigger
          className="w-full"
          aria-invalid={!known && Boolean(value)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {effectiveOptions.map((option) => (
              <SelectItem
                key={option.value ?? DEFAULT_VALUE}
                value={option.value ?? DEFAULT_VALUE}
                disabled={!known && option.value === value}
              >
                {option.value === null
                  ? m.agent_actors_client_default()
                  : option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {!known && value ? (
        <FieldError>{m.agent_actors_selector_unknown()}</FieldError>
      ) : null}
    </Field>
  );
}
