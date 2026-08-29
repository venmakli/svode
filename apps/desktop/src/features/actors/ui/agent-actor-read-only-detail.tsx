import { ChevronDown, LoaderCircle, ShieldAlert } from "lucide-react";

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
import * as m from "@/paraglide/messages.js";

import type {
  AgentActorAdapterDescriptor,
  AgentActorAdapterDiagnostic,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";
import {
  agentActorApprovalDescription,
  agentActorApprovalLabel,
  agentActorDiagnosticStatus,
  agentActorDiagnosticSummary,
  agentActorEffectiveBoundary,
  agentActorSelectorLabel,
  agentActorValidationIssueLabel,
} from "./agent-actor-copy";

export function AgentActorReadOnlyDetail({
  descriptors,
  diagnostics,
  draft,
  pendingAdapter,
  runtime,
  onCheck,
}: {
  descriptors: readonly AgentActorAdapterDescriptor[];
  diagnostics: Readonly<
    Partial<Record<AgentActorBinding["adapter"], AgentActorAdapterDiagnostic>>
  >;
  draft: AgentActorDraft;
  pendingAdapter: AgentActorBinding["adapter"] | null;
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >;
  onCheck(adapter: AgentActorBinding["adapter"]): void;
}) {
  return (
    <div
      className="flex min-h-0 flex-col gap-5"
      data-agent-actor-read-only-detail
    >
      <section className="flex flex-col gap-2" data-agent-actor-access>
        <h3 className="text-sm font-medium">{m.agent_actors_access_title()}</h3>
        <AccessSummary mode={draft.approvalMode} />
      </section>

      <section className="flex flex-col gap-2" data-agent-actor-adapters>
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            {m.agent_actors_adapters_title()}
          </h3>
          {draft.adapters.length > 1 ? (
            <p className="text-sm text-muted-foreground">
              {m.agent_actors_detail_adapters_hint()}
            </p>
          ) : null}
        </div>
        <ol className="flex flex-col gap-3">
          {draft.adapters.map((binding, index) => {
            const descriptor = descriptors.find(
              (candidate) => candidate.id === binding.adapter,
            );
            return (
              <li key={binding.adapter}>
                <ReadOnlyAdapterCard
                  binding={binding}
                  checkDisabled={pendingAdapter !== null}
                  descriptor={descriptor}
                  diagnostic={diagnostics[binding.adapter]}
                  pending={pendingAdapter === binding.adapter}
                  primary={index === 0}
                  runtime={runtime[binding.adapter]}
                  onCheck={() => onCheck(binding.adapter)}
                />
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function AccessSummary({ mode }: { mode: AgentActorDraft["approvalMode"] }) {
  const title = (
    <span className="flex flex-wrap items-center gap-2">
      {agentActorApprovalLabel(mode)}
      <Badge variant="outline">{m.agent_actors_device_local()}</Badge>
    </span>
  );
  const description = agentActorApprovalDescription(mode);

  if (mode === "full") {
    return (
      <Alert variant="destructive">
        <ShieldAlert />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ReadOnlyAdapterCard({
  binding,
  checkDisabled,
  descriptor,
  diagnostic,
  pending,
  primary,
  runtime,
  onCheck,
}: {
  binding: AgentActorBinding;
  checkDisabled: boolean;
  descriptor?: AgentActorAdapterDescriptor;
  diagnostic?: AgentActorAdapterDiagnostic;
  pending: boolean;
  primary: boolean;
  runtime?: AgentActorBindingRuntime;
  onCheck(): void;
}) {
  const client = descriptor?.label ?? binding.adapter;
  const diagnosticSummary = agentActorDiagnosticSummary(diagnostic);
  const status = agentActorDiagnosticStatus(diagnostic, pending);
  const model = agentActorSelectorLabel(binding.model);
  const effort = agentActorSelectorLabel(binding.effort);

  return (
    <Collapsible>
      <Card size="sm" data-agent-adapter={binding.adapter}>
        <CardHeader>
          <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <span>{client}</span>
            <Badge variant={primary ? "default" : "secondary"}>
              {primary ? m.agent_actors_primary() : m.agent_actors_fallback()}
            </Badge>
            <Badge
              variant={statusVariant(diagnostic, pending)}
              aria-live="polite"
            >
              {status}
            </Badge>
          </CardTitle>
          <CardDescription>
            {m.agent_actors_adapter_configuration({ effort, model })}
          </CardDescription>
          <CardAction className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={m.agent_actors_check_named({ client })}
              disabled={checkDisabled}
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
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={m.agent_actors_toggle_adapter_named({ client })}
              >
                <ChevronDown />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3">
            {runtime ? (
              <Alert>
                <AlertTitle>
                  {m.agent_actors_effective_boundary_label()}
                </AlertTitle>
                <AlertDescription>
                  {agentActorEffectiveBoundary(runtime.approval.native)}
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {m.agent_actors_binding_checking()}
              </p>
            )}
            {runtime?.validation.issues.map((issue) => (
              <Alert key={`${issue.field}:${issue.code}`} variant="destructive">
                <AlertDescription>
                  {agentActorValidationIssueLabel(issue)}
                </AlertDescription>
              </Alert>
            ))}
            {diagnosticSummary ? (
              <Alert variant="destructive" data-agent-adapter-diagnostic>
                <AlertTitle>{diagnosticSummary}</AlertTitle>
                {diagnostic?.message ? (
                  <AlertDescription>
                    {m.agent_actors_diagnostic_raw_detail()}:{" "}
                    {diagnostic.message}
                  </AlertDescription>
                ) : null}
              </Alert>
            ) : null}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function statusVariant(
  diagnostic: AgentActorAdapterDiagnostic | undefined,
  pending: boolean,
) {
  if (pending || !diagnostic) return "secondary" as const;
  if (diagnostic.status === "ready") return "outline" as const;
  return "destructive" as const;
}
