import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { publicationBlockCopy, type GitPublicationStatus } from "../model";
import type { PublishSpaces } from "../hooks/use-publish-spaces";
import { GitPublicationBlockedSpaces } from "./git-publication-block";
import { publicationCopy } from "./git-publication-copy";

export function GitPublicationResult({
  publication,
  error,
  publish,
  onOpenSpace,
}: {
  publication: GitPublicationStatus;
  error: string | null;
  /** The Spaces that kept the project version, with their publication. */
  publish?: PublishSpaces;
  onOpenSpace?: (spacePath: string) => void;
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
        {copy.block && publish && (
          <div className="mt-1 flex min-w-0 flex-col gap-1">
            <p className="font-medium text-foreground">
              {publicationBlockCopy(publish.spaces).title}
            </p>
            <GitPublicationBlockedSpaces
              publish={publish}
              onOpenSpace={onOpenSpace}
            />
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </AlertDescription>
    </Alert>
  );
}
