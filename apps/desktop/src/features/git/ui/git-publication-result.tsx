import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { GitPublicationStatus } from "../model";
import { GitPublicationBlockedSpaces } from "./git-publication-block";
import { publicationCopy } from "./git-publication-copy";
import * as m from "@/paraglide/messages.js";

export function GitPublicationResult({
  publication,
  error,
}: {
  publication: GitPublicationStatus;
  error: string | null;
}) {
  const copy = publicationCopy(publication);
  return (
    <Alert>
      <AlertTitle className="break-words">{copy.summary}</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-1 break-words [&_p:not(:last-child)]:mb-0">
        <p>{copy.child}</p>
        <p>{copy.parent}</p>
        <p className="break-all">{publication.parent.repository}</p>
        {copy.reason && <p>{copy.reason}</p>}
        {copy.block && (
          <div className="mt-1 flex min-w-0 flex-col gap-1">
            <p className="font-medium text-foreground">
              {m.git_publication_block_title()}
            </p>
            <GitPublicationBlockedSpaces block={copy.block} />
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </AlertDescription>
    </Alert>
  );
}
