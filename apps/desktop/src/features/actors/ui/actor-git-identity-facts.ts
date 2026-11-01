import type { CollectionPropertyFactGroup } from "@/features/properties/panel";
import * as m from "@/paraglide/messages.js";

import { visibleActorAliases } from "../model/actor-values";
import type {
  ActorCatalogItem,
  ActorSource,
  ActorSourceKind,
} from "../model/types";

/**
 * "Git identities" of a person in its property panel: the primary identity
 * and each alias with the sources it comes from.
 */
export function actorGitIdentityFacts(
  actor: ActorCatalogItem,
): CollectionPropertyFactGroup {
  return {
    facts: [
      {
        key: "primary",
        label: m.actors_primary_identity(),
        value: {
          kind: "text",
          text: identityText(
            actor.displayName,
            actor.canonicalEmail,
            identityProvenance(actor.sources, actor.canonicalEmail, null),
          ),
        },
      },
      ...visibleActorAliases(actor).map((alias, index) => ({
        key: `alias:${index}:${alias.email}`,
        label: m.actors_alias_identity(),
        value: {
          kind: "text" as const,
          text: identityText(
            alias.name,
            alias.email,
            identityProvenance(actor.sources, alias.email, alias.line),
          ),
        },
      })),
    ],
    key: "git-identities",
    label: m.actors_git_identities(),
  };
}

function identityText(
  name: string | null,
  email: string,
  provenance: readonly string[],
) {
  const identity = name ? `${name} <${email}>` : email;
  return provenance.length > 0
    ? `${identity}\n${provenance.join(" · ")}`
    : identity;
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
