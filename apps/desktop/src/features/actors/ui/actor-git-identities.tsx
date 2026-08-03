import { ChevronRight } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import * as m from "@/paraglide/messages.js";

import { visibleActorAliases } from "../model/actor-values";
import type {
  ActorCatalogRow,
  ActorSource,
  ActorSourceKind,
} from "../model/types";

export function ActorGitIdentities({ actor }: { actor: ActorCatalogRow }) {
  const aliases = visibleActorAliases(actor);
  return (
    <Collapsible className="rounded-lg border" defaultOpen={false}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {m.actors_git_identities()}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {m.actors_git_identities_summary({
              aliases: String(aliases.length),
              sources: String(actor.sources.length),
            })}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col border-t px-3 py-1">
          <IdentityLine
            email={actor.canonicalEmail}
            label={m.actors_primary_identity()}
            name={actor.displayName}
            provenance={identityProvenance(
              actor.sources,
              actor.canonicalEmail,
              null,
            )}
          />
          {aliases.map((alias, index) => (
            <IdentityLine
              email={alias.email}
              key={`${alias.name ?? ""}:${alias.email}:${alias.line ?? ""}:${index}`}
              name={alias.name}
              provenance={identityProvenance(
                actor.sources,
                alias.email,
                alias.line,
              )}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function IdentityLine({
  email,
  label,
  name,
  provenance,
}: {
  email: string;
  label?: string;
  name: string | null;
  provenance: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0">
      <div className="flex min-w-0 items-baseline gap-2">
        {label ? (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {label}
          </span>
        ) : null}
        {name ? (
          <span className="truncate text-sm font-medium">{name}</span>
        ) : null}
        <span className="truncate text-xs text-muted-foreground">{email}</span>
      </div>
      {provenance.length > 0 ? (
        <span className="truncate text-xs text-muted-foreground/80">
          {provenance.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

function identityProvenance(
  sources: readonly ActorSource[],
  email: string,
  mailmapLine: number | null,
) {
  const labels = sources
    .filter((source) => source.email === email)
    .map(sourceProvenance);
  if (mailmapLine !== null) {
    labels.push(
      `${m.actors_source_mailmap()}: ${m.actors_source_line({ line: String(mailmapLine) })}`,
    );
  }
  return [...new Set(labels)];
}

function sourceProvenance(source: ActorSource) {
  const label = sourceLabel(source.kind);
  return source.line === null
    ? label
    : `${label}: ${m.actors_source_line({ line: String(source.line) })}`;
}

function sourceLabel(kind: ActorSourceKind) {
  if (kind === "current_git_identity") {
    return m.actors_source_current_git_identity();
  }
  if (kind === "mailmap") return m.actors_source_mailmap();
  return m.actors_source_history();
}
