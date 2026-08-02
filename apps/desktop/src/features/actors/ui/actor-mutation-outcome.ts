import { toast } from "sonner";

import { actorMutationPersistenceFeedback } from "../lib/persistence-feedback";
import type { AppliedActorMutationResult } from "../model/identity-mutation";

export function showActorMutationOutcome(result: AppliedActorMutationResult) {
  const feedback = actorMutationPersistenceFeedback(result);
  toast[feedback.tone](feedback.title, {
    description: feedback.description,
  });
}
