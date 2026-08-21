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
import * as m from "@/paraglide/messages.js";

import { actorOwnerLabel } from "../model/agent-actor-draft";
import type { AgentActorCreateStep } from "../model/agent-actor-draft";
import type {
  AgentActorAdapterDescriptor,
  AgentActorBinding,
  AgentActorBindingRuntime,
  AgentActorDraft,
} from "../model/agent-actor-types";

export function AgentActorCreateReview({
  descriptors,
  draft,
  runtime,
  onEdit,
}: {
  descriptors: readonly AgentActorAdapterDescriptor[];
  draft: AgentActorDraft;
  runtime: Partial<
    Record<AgentActorBinding["adapter"], AgentActorBindingRuntime>
  >;
  onEdit(step: Exclude<AgentActorCreateStep, "review">): void;
}) {
  return (
    <div className="flex flex-col gap-3" data-agent-actor-review>
      <ReviewCard
        description={m.agent_actors_review_identity_description()}
        title={m.agent_actors_step_identity()}
        onEdit={() => onEdit("identity")}
      >
        <dl className="grid gap-2 text-sm">
          <ReviewValue
            label={m.agent_actors_name_label()}
            value={draft.name.trim()}
          />
          {draft.description.trim() ? (
            <ReviewValue
              label={m.agent_actors_description_label()}
              value={draft.description.trim()}
            />
          ) : null}
          <ReviewValue
            label={m.agent_actors_field_space()}
            value={actorOwnerLabel(draft.ownerPath)}
          />
        </dl>
      </ReviewCard>

      <ReviewCard
        description={m.agent_actors_review_adapters_description()}
        title={m.agent_actors_step_adapters()}
        onEdit={() => onEdit("adapters")}
      >
        <ol className="flex flex-col gap-3">
          {draft.adapters.map((binding, index) => {
            const descriptor = descriptors.find(
              (candidate) => candidate.id === binding.adapter,
            );
            return (
              <li key={binding.adapter} className="flex flex-col gap-1 text-sm">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {descriptor?.label ?? binding.adapter}
                  <Badge variant={index === 0 ? "default" : "secondary"}>
                    {index === 0
                      ? m.agent_actors_primary()
                      : m.agent_actors_fallback()}
                  </Badge>
                </span>
                <span className="text-muted-foreground">
                  {m.agent_actors_review_adapter_configuration({
                    effort:
                      binding.effort ??
                      descriptor?.defaultEffortLabel ??
                      m.agent_actors_client_default(),
                    model:
                      binding.model ??
                      descriptor?.defaultModelLabel ??
                      m.agent_actors_client_default(),
                  })}
                </span>
              </li>
            );
          })}
        </ol>
      </ReviewCard>

      <ReviewCard
        description={m.agent_actors_review_permissions_description()}
        title={m.agent_actors_step_permissions()}
        onEdit={() => onEdit("permissions")}
      >
        <div className="flex flex-col gap-3">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {approvalLabel(draft.approvalMode)}
            <Badge variant="outline">
              {m.agent_actors_review_device_local()}
            </Badge>
          </span>
          <dl className="grid gap-3 text-sm">
            {draft.adapters.map((binding) => {
              const descriptor = descriptors.find(
                (candidate) => candidate.id === binding.adapter,
              );
              const mapping = runtime[binding.adapter]?.approval;
              return (
                <ReviewValue
                  key={binding.adapter}
                  label={descriptor?.label ?? binding.adapter}
                  value={
                    mapping
                      ? `${mapping.label}: ${mapping.effectiveBoundary}`
                      : m.agent_actors_binding_checking()
                  }
                />
              );
            })}
          </dl>
        </div>
      </ReviewCard>
    </div>
  );
}

function ReviewCard({
  children,
  description,
  title,
  onEdit,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
  onEdit(): void;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            {m.agent_actors_review_edit()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ReviewValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="font-medium">{label}</dt>
      <dd className="text-muted-foreground">{value}</dd>
    </div>
  );
}

function approvalLabel(mode: AgentActorDraft["approvalMode"]) {
  if (mode === "auto") return m.agent_actors_approval_auto();
  if (mode === "full") return m.agent_actors_approval_full();
  return m.agent_actors_approval_ask();
}
