import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { PlateDocumentEditor } from "@/features/editor";
import * as m from "@/paraglide/messages.js";
import { detailPageBodyClassName } from "@/shared/ui/page-layout";
import { useEntryDetailContext } from "../hooks/entry-detail-context";

export function ReadmeSurface() {
  const context = useEntryDetailContext();
  if (context.status === "loading") return <ReadmeSurfaceSkeleton />;
  if (context.status === "missing") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.scope_readme_missing_title()}</EmptyTitle>
          <EmptyDescription>
            {m.scope_readme_missing_description()}
          </EmptyDescription>
          <Button
            onClick={() => void context.createReadme().catch(() => undefined)}
          >
            {m.scope_readme_create()}
          </Button>
        </EmptyHeader>
      </Empty>
    );
  }
  if (context.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>{m.scope_readme_error_title()}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{context.error}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void context.reload()}>
              {m.identity_load_retry()}
            </Button>
            <Button
              variant="outline"
              onClick={() => context.onOpenPath(context.readmePath)}
            >
              {m.scope_readme_open_file()}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }
  if (!context.entry) return null;
  return (
    <PlateDocumentEditor
      bodyOnly
      pageScroll
      documentPath={context.entry.path}
      documentSpaceId={context.spaceId}
      spacePath={context.spacePath}
      projectPath={context.projectPath}
      bodyOnlyMeta={context.entry.meta}
      initialEntry={context.entry}
      initialEntrySpacePath={context.spacePath}
      onDocumentPathChange={(path) =>
        context.setEntry((current) =>
          current ? { ...current, path } : current,
        )
      }
    />
  );
}

function ReadmeSurfaceSkeleton() {
  return (
    <div
      className={`${detailPageBodyClassName} flex flex-col gap-4`}
      aria-hidden="true"
    >
      <Skeleton className="h-6 w-2/3 max-w-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full max-w-3xl" />
        <Skeleton className="h-4 w-11/12 max-w-3xl" />
        <Skeleton className="h-4 w-4/5 max-w-2xl" />
      </div>
      <Skeleton className="mt-2 h-5 w-2/5 max-w-sm" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full max-w-3xl" />
        <Skeleton className="h-4 w-3/4 max-w-2xl" />
      </div>
    </div>
  );
}
