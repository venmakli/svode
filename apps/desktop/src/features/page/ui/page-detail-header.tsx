import type { ReactNode } from "react";
import { useSignalUserEdit } from "@/features/navigation";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { usePageDetailContext } from "../hooks/page-detail-context";
import { usePageMergeState } from "../model/page-merge";
import { pageWithMerge } from "../model/page-merge-view";
import type { Page } from "../model/types";
import {
  showPageHeaderSaveError,
  type PageHeaderSaveField,
} from "../lib/errors";
import {
  PageIdentityHeader,
  PageIdentityHeaderSkeleton,
} from "./page-identity-header";
import { PageReadError } from "./page-read-error";
import { PageSaveStatus } from "./page-save-status";
import { PageMergeUnavailable } from "./page-merge-unavailable";
import { PagePropertyPanel } from "./page-property-panel";
import { PageSystemFields } from "./page-system-fields";

export function PageDetailHeader({
  actions,
  readOnly = false,
  showReadError = true,
  metadataBefore,
  presentation = "full",
}: {
  actions?: ReactNode;
  metadataBefore?: ReactNode;
  presentation?: "full" | "compact";
  readOnly?: boolean;
  showReadError?: boolean;
}) {
  const context = usePageDetailContext();
  const signalUserEdit = useSignalUserEdit();
  const { page: sourcePage, schemaResult } = context;
  // While the frontmatter is in conflict the header shows the merged
  // properties, read only until the editor writes the decisions (DF-292).
  const merge = usePageMergeState(context.spacePath, sourcePage?.path);
  const page =
    sourcePage && merge ? pageWithMerge(sourcePage, merge) : sourcePage;

  if (context.status === "loading") {
    return <PageDetailHeaderSkeleton actions={actions} />;
  }

  const metadataReadOnly =
    readOnly ||
    merge !== null ||
    (context.status !== "missing" && context.status !== "ready");
  const canCreateReadme = context.status === "missing" && !readOnly;
  // A failed write the save block presents is not reported again.
  const saveHeaderField = (field: PageHeaderSaveField) => (error: unknown) => {
    if (!context.writeFailureShown(error))
      showPageHeaderSaveError(field, error);
  };
  // A failed write the save block keeps to retry is not reported again at
  // the property; any other refusal is.
  const saveProperty = (field: string, value: unknown) =>
    context.updateField(field, value).catch((error: unknown) => {
      if (!context.writeFailureShown(error)) throw error;
    });
  const createReadme = () => {
    if (canCreateReadme)
      void context.createReadme().catch(saveHeaderField("readme"));
  };

  return (
    <div className={detailPageHeaderClassName} data-page-detail-header>
      <PageIdentityHeader
        title={page?.meta.title ?? context.fallbackTitle}
        icon={
          (context.metadataDrafts.get("icon")?.value as string | undefined) ??
          page?.meta.icon ??
          null
        }
        description={
          (context.metadataDrafts.get("description")?.value as
            | string
            | undefined) ??
          page?.meta.description ??
          ""
        }
        cover={page?.meta.cover ?? null}
        projectPath={context.projectPath}
        spacePath={context.spacePath}
        pagePath={page?.path ?? context.readmePath}
        onTitleChange={(value) =>
          void context.updateTitle(value).catch(saveHeaderField("title"))
        }
        titleError={context.titleError}
        titleFocusRequest={context.titleFocusRequest}
        onIconChange={(value) =>
          void context.updateField("icon", value).catch(saveHeaderField("icon"))
        }
        onDescriptionChange={(value) =>
          void context
            .updateField("description", value)
            .catch(saveHeaderField("description"))
        }
        onCoverChange={(value) =>
          void context.updateCover(value).catch(saveHeaderField("cover"))
        }
        onBodyFocus={() => undefined}
        actions={actions}
        metadata={
          <>
            {metadataBefore}
            <PageSaveStatus
              title={context.title}
              error={context.writeError}
              onRetry={context.writeError ? context.retryWrites : undefined}
            >
              {page ? <PageSystemFields meta={page.meta} /> : null}
            </PageSaveStatus>
          </>
        }
        hideCover={!page}
        titleReadOnly={!page || metadataReadOnly}
        fallbackEmoji={!page ? context.fallbackIcon : null}
        onActivateIdentity={canCreateReadme ? createReadme : undefined}
        coverSize="compact"
        readOnly={metadataReadOnly}
      />
      {showReadError && context.status === "error" ? <PageReadError /> : null}
      {page && merge?.merge.type === "unavailable" ? (
        <div className="max-w-5xl">
          <PageMergeUnavailable
            spacePath={context.spacePath}
            path={page.path}
            reason={merge.merge.reason}
            readOnly={readOnly}
          />
        </div>
      ) : sourcePage &&
        (merge ||
          (schemaResult &&
            (schemaResult.schema.columns.length > 0 || !readOnly))) ? (
        <div className="max-w-5xl">
          <PagePropertyPanel
            key={`properties:${readOnly ? "view" : "edit"}`}
            spacePath={context.spacePath}
            projectPath={context.projectPath}
            spaceId={context.spaceId}
            page={
              schemaResult
                ? pageWithDrafts(
                    sourcePage,
                    schemaResult.schema.columns,
                    context.metadataDrafts,
                  )
                : sourcePage
            }
            schemaResult={schemaResult}
            presentation={presentation}
            readOnly={readOnly}
            onOpenPath={context.onOpenPath}
            onSchemaChange={(result) => {
              context.applySchema(result);
              signalUserEdit();
            }}
            onValueChange={saveProperty}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Unsaved field drafts stay visible until they are saved or discarded. */
function pageWithDrafts(
  page: Page,
  columns: readonly { name: string }[],
  drafts: ReadonlyMap<string, { value: unknown }>,
): Page {
  const values = { ...(page.meta.extra ?? {}) };
  for (const { name } of columns) {
    const draft = drafts.get(name);
    if (draft) values[name] = draft.value;
  }
  return { ...page, meta: { ...page.meta, extra: values } };
}

function PageDetailHeaderSkeleton({ actions }: { actions?: ReactNode }) {
  return (
    <div
      className={detailPageHeaderClassName}
      aria-hidden={actions ? undefined : true}
    >
      <PageIdentityHeaderSkeleton actions={actions} />
    </div>
  );
}
