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

const DEFAULT_VALUE = "__client_default__";

export function AgentAdapterCard({
  approvalMapping,
  binding,
  canRemove,
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
      defaultOpen={open === undefined ? !readOnly : undefined}
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
            {binding.model ??
              descriptor?.defaultModelLabel ??
              m.agent_actors_client_default()}
            {" · "}
            {binding.effort ??
              descriptor?.defaultEffortLabel ??
              m.agent_actors_client_default()}
            {" · "}
            {diagnosticLabel(diagnostic)}
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
            {!readOnly ? (
              <FieldGroup>
                <AdapterSelectField
                  label={m.agent_actors_model_label()}
                  options={descriptor?.modelOptions ?? []}
                  value={binding.model}
                  onChange={(model) =>
                    onChange({ ...binding, effort: null, model })
                  }
                />
                <AdapterSelectField
                  label={m.agent_actors_effort_label()}
                  options={effortOptions}
                  value={binding.effort}
                  onChange={(effort) => onChange({ ...binding, effort })}
                />
              </FieldGroup>
            ) : null}
            {approvalMapping ? (
              <Alert
                variant={approvalMapping.danger ? "destructive" : "default"}
              >
                <AlertTitle>{approvalMapping.label}</AlertTitle>
                <AlertDescription>
                  {approvalMapping.effectiveBoundary}
                </AlertDescription>
              </Alert>
            ) : null}
            {validation?.issues.map((issue) => (
              <Alert key={`${issue.field}:${issue.code}`} variant="destructive">
                <AlertDescription>{issue.message}</AlertDescription>
              </Alert>
            ))}
            {diagnostic?.message ? (
              <Alert
                variant={
                  diagnostic.status === "ready" ? "default" : "destructive"
                }
              >
                <AlertDescription>{diagnostic.message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
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
              {!readOnly && !primary ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onMakePrimary}
                >
                  {m.agent_actors_make_primary()}
                </Button>
              ) : null}
              {!readOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canRemove}
                  onClick={onRemove}
                >
                  <Trash2 data-icon="inline-start" />
                  {m.agent_actors_remove_adapter()}
                </Button>
              ) : null}
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
  value,
}: {
  label: string;
  onChange(value: string | null): void;
  options: readonly AgentActorSelectOption[];
  value: string | null;
}) {
  const known = options.some((option) => option.value === value);
  const effectiveOptions =
    !known && value ? [{ label: value, value }, ...options] : options;
  return (
    <Field data-invalid={!known && Boolean(value)}>
      <FieldLabel>{label}</FieldLabel>
      <Select
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
                {option.label}
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

function diagnosticLabel(diagnostic?: AgentActorAdapterDiagnostic) {
  if (!diagnostic || diagnostic.status === "unknown")
    return m.agent_actors_status_unchecked();
  if (diagnostic.status === "ready") return m.agent_actors_status_ready();
  return m.agent_actors_status_attention();
}
