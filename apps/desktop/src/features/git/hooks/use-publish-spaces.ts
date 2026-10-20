import { toast } from "sonner";
import { publishBlockedSpaces } from "../api/git-spaces-publication-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import {
  runForBlock,
  spacesToPublish,
  useSpacesPublicationStore,
  type GitAuthChallenge,
  type GitPublicationBlock,
  type GitPublicationBlockedSpace,
  type GitSpacesPublicationRun,
} from "../model";
import { isFullSyncSuccess } from "../model/publication";
import { usePublicationBlockedSpaces } from "./use-publication-blocked-spaces";
import * as m from "@/paraglide/messages.js";

const NO_BLOCK: GitPublicationBlock = { project: "", spaces: [] };

export interface PublishSpacesHandlers {
  /** The Dialog of the project asks for its sign-in itself. */
  onAuthRequired?: (challenge: GitAuthChallenge) => void;
  /** The project synced: the Dialog finishes like a successful sync. */
  onSynced: () => void;
}

export interface PublishSpaces {
  /** The list shown: the one the action started from while it runs. */
  block: GitPublicationBlock | null;
  spaces: GitPublicationBlockedSpace[];
  steps: GitSpacesPublicationRun["steps"];
  partial: GitSpacesPublicationRun["partial"];
  running: boolean;
  /** At least one shown Space can still be published. */
  available: boolean;
  label: string;
  publish: () => Promise<void>;
}

/**
 * The explicit action on the Spaces that stop a project sync: publish the
 * publishable ones, then sync the project when they were the whole list.
 */
export function usePublishSpaces(
  block: GitPublicationBlock | null,
  handlers: PublishSpacesHandlers,
): PublishSpaces {
  const stored = useSpacesPublicationStore((state) =>
    block ? state.runs[block.project] : undefined,
  );
  const shown = stored?.running ? stored.block : block;
  const run = runForBlock(stored, shown);
  const spaces = usePublicationBlockedSpaces(shown ?? NO_BLOCK);
  const pending = spacesToPublish(spaces, run);
  async function publish() {
    if (!shown || run?.running || pending.length === 0) return;
    const outcome = await publishBlockedSpaces(shown, pending);
    const project = outcome.project;
    if (!project) {
      // The fresh proof took none of them: the list itself is outdated.
      if (outcome.total === 0)
        toast.info(m.git_sync_publication_blocked_status());
      return;
    }
    if (
      project.type === "AuthRequired" &&
      project.challenge &&
      handlers.onAuthRequired
    ) {
      handlers.onAuthRequired(project.challenge);
      return;
    }
    notifyGitSyncOutcome(project);
    if (!isFullSyncSuccess(project)) return;
    toast.success(
      outcome.published > 0
        ? m.git_publication_spaces_synced({ count: String(outcome.published) })
        : m.git_sync_success(),
    );
    handlers.onSynced();
  }
  return {
    block: shown,
    spaces,
    steps: run?.steps ?? {},
    partial: run?.running ? undefined : run?.partial,
    running: !!run?.running,
    available: pending.length > 0,
    label: spaces.every((space) => space.publishable)
      ? m.git_publication_publish_and_sync()
      : m.git_publication_publish_spaces(),
    publish,
  };
}
