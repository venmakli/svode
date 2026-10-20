import { CloudUpload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { usePublicationBlockedSpaces } from "../hooks/use-publication-blocked-spaces";
import type {
  GitPublicationBlock,
  GitPublicationBlockedSpace,
} from "../model/publication-block";
import * as m from "@/paraglide/messages.js";

/**
 * The slot of the Git sync Dialog for a project publication stopped by
 * Spaces: what has to happen first and what each Space needs.
 */
export function GitPublicationBlockNotice({
  block,
}: {
  block: GitPublicationBlock;
}) {
  return (
    <Alert data-git-publication-block>
      <CloudUpload />
      <AlertTitle className="break-words">
        {m.git_publication_block_title()}
      </AlertTitle>
      <AlertDescription className="min-w-0">
        <GitPublicationBlockedSpaces block={block} />
      </AlertDescription>
    </Alert>
  );
}

/** One row per blocked Space: its name and one sentence about it. */
export function GitPublicationBlockedSpaces({
  block,
}: {
  block: GitPublicationBlock;
}) {
  const spaces = usePublicationBlockedSpaces(block);
  return (
    <ul
      aria-label={m.git_publication_block_spaces()}
      className="flex max-h-60 min-w-0 flex-col gap-2 overflow-y-auto"
    >
      {spaces.map((space) => (
        <li
          key={space.path}
          className="flex min-w-0 flex-col"
          data-publication-blocked-space={space.path}
          data-publication-space-class={space.class}
          data-publishable={space.publishable || undefined}
        >
          <span
            className="min-w-0 truncate font-medium text-foreground"
            title={space.name}
          >
            {space.name}
          </span>
          <span className="break-words">{blockedSpaceText(space)}</span>
        </li>
      ))}
    </ul>
  );
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
