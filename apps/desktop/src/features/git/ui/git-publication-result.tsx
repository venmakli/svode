import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { GitPublicationStatus } from "../model";
import { publicationCopy } from "./git-publication-copy";

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
        {error && <p role="alert">{error}</p>}
      </AlertDescription>
    </Alert>
  );
}
