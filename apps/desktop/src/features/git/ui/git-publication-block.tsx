import { AlertTriangle, Check, CloudUpload, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { gitSyncErrorMessage } from "../api/git-sync-error";
import type { PublishSpaces } from "../hooks/use-publish-spaces";
import type {
  GitPublicationBlockedSpace,
  GitSpacePublicationStep,
} from "../model";
import { gitSyncStopTitle } from "./git-sync-stop-copy";
import * as m from "@/paraglide/messages.js";

/**
 * The slot of the Git sync Dialog for a project publication stopped by
 * Spaces: what has to happen first and what each Space needs.
 */
export function GitPublicationBlockNotice({
  publish,
  onOpenSpace,
}: {
  publish: PublishSpaces;
  onOpenSpace?: (spacePath: string) => void;
}) {
  return (
    <Alert data-git-publication-block>
      <CloudUpload />
      <AlertTitle className="break-words">
        {m.git_publication_block_title()}
      </AlertTitle>
      <AlertDescription className="min-w-0">
        <GitPublicationBlockedSpaces
          publish={publish}
          onOpenSpace={onOpenSpace}
        />
      </AlertDescription>
    </Alert>
  );
}

/**
 * One row per blocked Space: its name and one sentence about it, which
 * follows the explicit publication of the Space while it runs.
 */
export function GitPublicationBlockedSpaces({
  publish,
  onOpenSpace,
}: {
  publish: PublishSpaces;
  onOpenSpace?: (spacePath: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {publish.partial && (
        <p
          role="status"
          className="font-medium text-foreground"
          data-spaces-publication-partial
        >
          {m.git_publication_spaces_partial({
            published: String(publish.partial.published),
            total: String(publish.partial.total),
          })}
        </p>
      )}
      <ul
        aria-label={m.git_publication_block_spaces()}
        className="flex max-h-60 min-w-0 flex-col gap-2 overflow-y-auto"
      >
        {publish.spaces.map((space) => {
          const step = publish.steps[space.path];
          return (
            <li
              key={space.path}
              className="flex min-w-0 flex-col"
              data-publication-blocked-space={space.path}
              data-publication-space-class={space.class}
              data-publishable={space.publishable || undefined}
              data-publication-step={step?.status}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <StepIcon step={step} />
                <span
                  className="min-w-0 truncate font-medium text-foreground"
                  title={space.name}
                >
                  {space.name}
                </span>
              </div>
              <span className="break-words">
                {step ? stepText(step) : blockedSpaceText(space)}
              </span>
              {step?.status === "failed" &&
                onOpenSpace &&
                !space.namedByPath && (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto self-start p-0 text-sm"
                    aria-label={m.git_publication_open_space_named({
                      name: space.name,
                    })}
                    onClick={() => onOpenSpace(space.spacePath)}
                  >
                    {m.git_publication_open_space()}
                  </Button>
                )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StepIcon({ step }: { step: GitSpacePublicationStep | undefined }) {
  switch (step?.status) {
    case "running":
      return (
        <RefreshCw className="size-3.5 animate-spin" data-step-icon="running" />
      );
    case "published":
      return <Check className="size-3.5" data-step-icon="published" />;
    case "failed":
      return (
        <AlertTriangle
          className="size-3.5 text-destructive"
          data-step-icon="failed"
        />
      );
    default:
      return null;
  }
}

function stepText(step: GitSpacePublicationStep): string {
  switch (step.status) {
    case "running":
      return m.git_publication_space_publishing();
    case "published":
      return m.git_publication_space_published();
    case "not_run":
      return m.git_publication_space_not_run();
    case "failed":
      return stepFailureText(step);
  }
}

/** Why the Space sync did not publish it, as an explicit sync tells it. */
function stepFailureText(step: GitSpacePublicationStep): string {
  if (step.error) return gitSyncErrorMessage(step.error);
  switch (step.result?.type) {
    case "Conflict":
    case "UnmergedFiles":
      return m.git_sync_conflict({ count: String(step.result.files.length) });
    case "AuthRequired":
      return m.git_sync_auth_required();
    case "OperationInProgress":
      return `${gitSyncStopTitle({ kind: "operation", operation: step.result.operation })}. ${m.git_sync_stop_operation_description()}`;
    case "NoRemote":
      return m.git_publication_space_no_remote();
    default:
      return m.git_sync_failed();
  }
}

function blockedSpaceText(space: GitPublicationBlockedSpace): string {
  switch (space.class) {
    case "local_commits":
      return space.readOnly
        ? m.git_publication_block_read_only()
        : m.git_publication_block_local_commits();
    case "missing":
      return m.git_publication_block_missing();
    case "outside_branch":
      return m.git_publication_block_outside_branch();
    case "unverified":
      return m.git_publication_block_unverified();
    case "source_unavailable":
      return m.git_sync_publication_source_unavailable();
    case "uninitialized":
      return m.git_sync_publication_uninitialized();
    case "configuration":
      return m.git_sync_publication_configuration();
  }
}
