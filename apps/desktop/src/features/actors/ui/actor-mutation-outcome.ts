import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import type {
  ActorExactPathPendingReason,
  AppliedActorMutationResult,
} from "../model/identity-mutation";

export function showActorMutationOutcome(result: AppliedActorMutationResult) {
  const identityDescription = result.currentIdentityUpdated
    ? m.actors_mutation_current_identity_updated()
    : undefined;
  if (result.persistence.status === "committed") {
    toast.success(m.actors_mutation_success_committed(), {
      description: identityDescription,
    });
    return;
  }
  if (result.persistence.status === "pending") {
    toast.warning(m.actors_mutation_success_pending(), {
      description: joinDescriptions(
        pendingReasonDescription(result.persistence.reason),
        identityDescription,
      ),
    });
    return;
  }
  if (result.persistence.status === "failed") {
    toast.warning(m.actors_mutation_success_commit_failed(), {
      description: joinDescriptions(
        result.persistence.message,
        identityDescription,
      ),
    });
    return;
  }
  toast.success(m.actors_mutation_success_clean(), {
    description: identityDescription,
  });
}

function pendingReasonDescription(reason: ActorExactPathPendingReason) {
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
    case "submodule_deferred":
      return m.actors_mutation_pending_submodule();
  }
}

function joinDescriptions(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(" ");
}
