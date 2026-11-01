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
  AgentActorAgentOption,
  AgentActorDraft,
} from "../model/agent-actor-types";
import { agentActorBindingLabel } from "./agent-actor-copy";

export function AgentActorCreateReview({
  agents,
  draft,
  onEdit,
}: {
  agents: readonly AgentActorAgentOption[];
  draft: AgentActorDraft;
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
        title={m.agent_actors_agent_label()}
        onEdit={() => onEdit("adapters")}
      >
        <p className="text-sm font-medium" data-agent-actor-binding>
          {agentActorBindingLabel(draft.binding, agents)}
        </p>
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
