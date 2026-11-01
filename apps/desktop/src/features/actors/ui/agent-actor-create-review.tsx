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

import type { AgentActorBindingEditor } from "../hooks/use-agent-actor-binding";
import { actorOwnerLabel } from "../model/agent-actor-draft";
import type { AgentActorCreateStep } from "../model/agent-actor-draft";
import type { AgentActorDraft } from "../model/agent-actor-types";
import { AgentActorBindingSummary } from "./agent-actor-binding-field";

export function AgentActorCreateReview({
  binding,
  draft,
  onEdit,
}: {
  binding: AgentActorBindingEditor;
  draft: AgentActorDraft;
  onEdit(step: Exclude<AgentActorCreateStep, "review">): void;
}) {
  const modeSetting = binding.modeSetting;
  const mode = draft.mode;
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
        onEdit={() => onEdit("agent")}
      >
        <div className="flex flex-col gap-2 text-sm">
          <p
            className="flex min-w-0 items-center gap-1.5 font-medium [&_svg]:size-4 [&_svg]:shrink-0"
            data-agent-actor-binding
          >
            <AgentActorBindingSummary binding={binding} />
          </p>
          {modeSetting && !binding.participant ? (
            <dl>
              <ReviewValue
                label={modeSetting.name}
                value={
                  mode
                    ? (modeSetting.options.find(
                        (option) => option.value === mode.value,
                      )?.name ?? mode.value)
                    : m.agent_actors_mode_agent_default()
                }
                note={m.agent_actors_on_this_device()}
              />
            </dl>
          ) : null}
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

function ReviewValue({
  label,
  note,
  value,
}: {
  label: string;
  note?: string;
  value: string;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="font-medium">{label}</dt>
      <dd className="text-muted-foreground">
        {value}
        {note ? <span className="block text-xs">{note}</span> : null}
      </dd>
    </div>
  );
}
