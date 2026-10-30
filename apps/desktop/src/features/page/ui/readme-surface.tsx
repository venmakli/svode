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
import { usePageDetailContext } from "../hooks/page-detail-context";
import { usePageSurfaceSession } from "../hooks/page-surface-context";
import { pageSaveBlock } from "../lib/save-block";
import { PageReadError } from "./page-read-error";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

export function ReadmeSurface() {
  const context = usePageDetailContext();
  const pageSurface = usePageSurfaceSession();
  const saveBlocked =
    pageSaveBlock({
      ownerError: context.writeError,
      persistenceError: pageSurface.persistenceError,
      recovery: pageSurface.recovery,
      sourceConflict: pageSurface.sourceConflict,
    }) !== null;
  const saveBlockedRef = useRef(saveBlocked);
  useEffect(() => {
    saveBlockedRef.current = saveBlocked;
  }, [saveBlocked]);
  const saveFailureShown = useCallback(() => saveBlockedRef.current, []);
  let content: ReactNode = null;
  if (context.status === "loading") content = <ReadmeSurfaceSkeleton />;
  if (context.status === "missing") {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.scope_readme_missing_title()}</EmptyTitle>
          <EmptyDescription>
            {m.scope_readme_missing_description()}
          </EmptyDescription>
          {!pageSurface.readOnly ? (
            <Button
              onClick={() => void context.createReadme().catch(() => undefined)}
            >
              {m.scope_readme_create()}
            </Button>
          ) : null}
        </EmptyHeader>
      </Empty>
    );
  }
  if (context.status === "error") content = <PageReadError openFile />;
  if (context.status === "ready" && context.page) {
    content = (
      <PlateDocumentEditor
        bodyOnly
        pageScroll
        documentPath={context.page.path}
        documentSpaceId={context.spaceId}
        spacePath={context.spacePath}
        projectPath={context.projectPath}
        bodyOnlyMeta={context.page.meta}
        initialPage={context.page}
        initialPageSpacePath={context.spacePath}
        onDocumentPathChange={context.adoptPath}
        documentPathHandoff={context.pathHandoff}
        readOnly={pageSurface.readOnly}
        registerPersistence={pageSurface.registerPersistence}
        onWriteAccessError={pageSurface.recoverSourceWriteError}
        saveFailureShown={saveFailureShown}
        onSourceConflict={pageSurface.reportSourceConflict}
        onCommitRefused={pageSurface.showCommitRefusal}
        prepareManagedImport={async () => {
          if (!(await pageSurface.prepareForNavigation()))
            throw new Error(m.page_surface_save_error());
        }}
      />
    );
  }
  return <>{content}</>;
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
