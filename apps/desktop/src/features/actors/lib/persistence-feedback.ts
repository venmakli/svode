import * as m from "@/paraglide/messages.js";

import type {
  ActorPersistenceOutcome,
  ActorRepositoryPersistenceOutcome,
  AppliedActorMutationResult,
} from "../model/identity-mutation";

export interface ActorPersistenceFeedback {
  description?: string;
  title: string;
  tone: "info" | "success" | "warning";
}

export function actorMutationPersistenceFeedback(
  result: AppliedActorMutationResult,
): ActorPersistenceFeedback {
  const mailmap = result.persistence.mailmap;
  const rootPointer = result.persistence.rootPointer;
  const identityDescription = result.currentIdentityUpdated
    ? m.actors_mutation_current_identity_updated()
    : undefined;
  const rootDescription = actorRootPointerDescription(rootPointer);

  if (mailmap.status === "committed") {
    return {
      description: joinDescriptions(rootDescription, identityDescription),
      title: m.actors_mutation_success_committed(),
      tone: actorPersistenceNeedsAttention(rootPointer) ? "warning" : "success",
    };
  }
  if (mailmap.status === "pending") {
    return {
      description: joinDescriptions(
        mailmapPendingDescription(mailmap.reason),
        rootDescription,
        identityDescription,
      ),
      title: m.actors_mutation_success_pending(),
      tone: "warning",
    };
  }
  if (mailmap.status === "failed") {
    return {
      description: joinDescriptions(
        mailmap.message,
        rootDescription,
        identityDescription,
      ),
      title: m.actors_mutation_success_commit_failed(),
      tone: "warning",
    };
  }
  return {
    description: joinDescriptions(rootDescription, identityDescription),
    title: m.actors_mutation_success_clean(),
    tone: actorPersistenceNeedsAttention(rootPointer) ? "warning" : "success",
  };
}

export function actorManualSaveFeedback(
  persistence: ActorRepositoryPersistenceOutcome,
): ActorPersistenceFeedback {
  const rootPointer = persistence.rootPointer;
  const rootDescription = actorRootPointerDescription(rootPointer);

  if (persistence.mailmap.status === "committed") {
    return {
      description: rootDescription,
      title: m.actors_mailmap_save_committed(),
      tone: actorPersistenceNeedsAttention(rootPointer) ? "warning" : "success",
    };
  }
  if (
    persistence.mailmap.status === "clean" &&
    rootPointer?.status === "committed"
  ) {
    return {
      title: m.actors_mailmap_save_pointer_only_committed(),
      tone: "success",
    };
  }
  if (
    persistence.mailmap.status === "clean" &&
    actorPersistenceNeedsAttention(rootPointer)
  ) {
    return {
      description: rootDescription,
      title: m.actors_mailmap_save_pointer_failed(),
      tone: "warning",
    };
  }
  if (persistence.mailmap.status === "failed") {
    return {
      description: joinDescriptions(
        persistence.mailmap.message,
        rootDescription,
      ),
      title: m.actors_mailmap_save_failed(),
      tone: "warning",
    };
  }
  if (persistence.mailmap.status === "pending") {
    return {
      description: joinDescriptions(
        mailmapPendingDescription(persistence.mailmap.reason),
        rootDescription,
      ),
      title: m.actors_mailmap_save_failed(),
      tone: "warning",
    };
  }
  return {
    description: rootDescription,
    title: m.actors_mailmap_save_clean(),
    tone: actorPersistenceNeedsAttention(rootPointer) ? "warning" : "info",
  };
}

export function actorRootPointerDescription(outcome?: ActorPersistenceOutcome) {
  if (!outcome) return undefined;
  if (outcome.status === "committed") {
    return m.actors_mutation_root_pointer_committed();
  }
  if (outcome.status === "clean") {
    return m.actors_mutation_root_pointer_clean();
  }
  if (outcome.status === "failed") {
    return m.actors_mutation_root_pointer_failed({ message: outcome.message });
  }
  switch (outcome.reason) {
    case "policy_off":
      return m.actors_mutation_root_pointer_policy();
    case "target_dirty":
      return m.actors_mutation_root_pointer_target_dirty();
    case "index_staged":
    case "index_interference":
      return m.actors_mutation_root_pointer_index();
    case "target_changed":
      return m.actors_mutation_root_pointer_target_changed();
  }
}

function mailmapPendingDescription(
  reason: Extract<ActorPersistenceOutcome, { status: "pending" }>["reason"],
) {
  switch (reason) {
    case "policy_off":
      return m.actors_mutation_pending_policy();
    case "target_dirty":
      return m.actors_mutation_pending_target_dirty();
    case "index_staged":
    case "index_interference":
      return m.actors_mutation_pending_index();
    case "target_changed":
      return m.actors_mutation_pending_target_changed();
  }
}

export function actorPersistenceNeedsAttention(
  outcome?: ActorPersistenceOutcome,
) {
  return outcome?.status === "pending" || outcome?.status === "failed";
}

function joinDescriptions(...parts: Array<string | undefined>) {
  const description = parts.filter(Boolean).join(" ");
  return description || undefined;
}
