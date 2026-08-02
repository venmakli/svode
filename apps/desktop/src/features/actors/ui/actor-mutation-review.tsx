import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Field, FieldGroup, FieldTitle } from "@/components/ui/field";
import * as m from "@/paraglide/messages.js";

import type {
  ActorCommitExpectation,
  ActorMutationReview,
} from "../model/identity-mutation";

export function ActorMutationReviewStep({
  review,
  commitExpectation,
}: {
  review: ActorMutationReview;
  commitExpectation: ActorCommitExpectation;
}) {
  return (
    <div className="flex flex-col gap-4" data-actor-mutation-review>
      <FieldGroup className="gap-3">
        <Field orientation="horizontal">
          <FieldTitle>{m.actors_mutation_review_name()}</FieldTitle>
          <span className="min-w-0 truncate text-right">
            {review.resultDisplayName}
          </span>
        </Field>
        <Field orientation="horizontal">
          <FieldTitle>{m.actors_mutation_review_email()}</FieldTitle>
          <span className="min-w-0 break-all text-right">
            {review.resultCanonicalEmail}
          </span>
        </Field>
      </FieldGroup>

      {review.transferredAliasEmails.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            {m.actors_mutation_review_aliases()}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {review.transferredAliasEmails.map((email) => (
              <Badge key={email} variant="secondary" className="max-w-full">
                <span className="truncate">{email}</span>
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {review.affectsCurrentIdentity ? (
        <Alert>
          <AlertTitle>{m.actors_mutation_review_current_title()}</AlertTitle>
          <AlertDescription>
            {m.actors_mutation_review_current_description()}
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {commitExpectation === "automatic_if_safe"
          ? m.actors_mutation_review_mailmap_automatic()
          : m.actors_mutation_review_mailmap_manual()}
      </p>
    </div>
  );
}
