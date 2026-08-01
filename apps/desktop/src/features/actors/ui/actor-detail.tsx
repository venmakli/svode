import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import * as m from "@/paraglide/messages.js";

import { visibleActorAliases } from "../model/actor-values";
import type { ActorCatalogRow, ActorSourceKind } from "../model/types";
import { ActorActivityHeatmap } from "./actor-activity-heatmap";

export function ActorDetail({
  actor,
  spacePath,
}: {
  actor: ActorCatalogRow;
  spacePath: string;
}) {
  const aliases = visibleActorAliases(actor);
  return (
    <div
      className="flex flex-col gap-5"
      data-actor-detail={actor.canonicalEmail}
    >
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          {actor.contribution === "contributor"
            ? m.actors_contribution_commits()
            : m.actors_contribution_no_commits()}
        </Badge>
        <Badge variant="outline">
          {m.actors_field_commits()}: {actor.commitCount}
        </Badge>
        <Badge variant="outline">
          {m.actors_field_activity()}: {actor.lastActivityDate ?? "—"}
        </Badge>
      </div>

      <DetailSection title={m.actors_identity()}>
        <IdentityRow
          label={m.actors_canonical_identity()}
          name={actor.displayName}
          email={actor.canonicalEmail}
        />
        {aliases.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {m.actors_aliases()}
            </span>
            {aliases.map((alias, index) => (
              <IdentityRow
                key={`${alias.name ?? ""}:${alias.email}:${alias.line ?? ""}:${index}`}
                name={alias.name}
                email={alias.email}
                line={alias.line}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {m.actors_no_aliases()}
          </span>
        )}
      </DetailSection>

      <DetailSection title={m.actors_identity_sources()}>
        <div className="flex flex-col gap-2">
          {actor.sources.map((source, index) => (
            <div
              key={`${source.kind}:${source.name}:${source.email}:${source.line ?? ""}:${index}`}
              className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">
                  {sourceLabel(source.kind)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[source.name, source.email].filter(Boolean).join(" · ")}
                </span>
              </div>
              {source.line !== null ? (
                <Badge variant="outline">
                  {m.actors_source_line({ line: String(source.line) })}
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      </DetailSection>

      <DetailSection title={m.actors_activity()}>
        <ActorActivityHeatmap
          canonicalEmail={actor.canonicalEmail}
          spacePath={spacePath}
        />
      </DetailSection>
    </div>
  );
}

function DetailSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Separator />
      </div>
      {children}
    </section>
  );
}

function IdentityRow({
  email,
  label,
  line,
  name,
}: {
  email: string;
  label?: string;
  line?: number | null;
  name?: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <div className="flex min-w-0 flex-col">
        {label ? (
          <span className="text-xs font-medium text-muted-foreground">
            {label}
          </span>
        ) : null}
        {name ? (
          <span className="truncate text-sm font-medium">{name}</span>
        ) : null}
        <span className="truncate text-xs text-muted-foreground">{email}</span>
      </div>
      {line !== null && line !== undefined ? (
        <Badge variant="outline">
          {m.actors_source_line({ line: String(line) })}
        </Badge>
      ) : null}
    </div>
  );
}

function sourceLabel(kind: ActorSourceKind) {
  if (kind === "current_git_identity") {
    return m.actors_source_current_git_identity();
  }
  if (kind === "mailmap") return m.actors_source_mailmap();
  return m.actors_source_history();
}
