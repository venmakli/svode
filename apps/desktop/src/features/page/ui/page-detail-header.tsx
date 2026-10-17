import type { ReactNode } from "react";
import { useSignalUserEdit } from "@/features/navigation";
import { PropertyPanel } from "@/features/properties/panel";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { usePageDetailContext } from "../hooks/page-detail-context";
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
  const { page, schemaResult } = context;

  if (context.status === "loading") {
    return <PageDetailHeaderSkeleton actions={actions} />;
  }

  const metadataReadOnly =
    readOnly || (context.status !== "missing" && context.status !== "ready");
  const canCreateReadme = context.status === "missing" && !readOnly;
  // A failed write the save block presents is not reported again.
  const saveHeaderField = (field: PageHeaderSaveField) => (error: unknown) => {
    if (!context.writeFailureShown(error))
      showPageHeaderSaveError(field, error);
  };
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
      {page && schemaResult?.schema.columns.length ? (
        <div className="max-w-5xl">
          <PropertyPanel
            key={`properties:${readOnly ? "view" : "edit"}`}
            spacePath={context.spacePath}
            projectPath={context.projectPath}
            spaceId={context.spaceId}
            filePath={page.path}
            pageLabel={page.meta.title}
            schemaResult={schemaResult}
            values={propertyValues(
              page.meta.extra ?? {},
              schemaResult.schema.columns,
              context.metadataDrafts,
            )}
            mode={presentation === "compact" ? "peek" : "full"}
            readOnly={readOnly}
            onOpenPath={context.onOpenPath}
            onSchemaChange={(result) => {
              context.applySchema(result);
              signalUserEdit();
            }}
            onValueChange={context.updateField}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Unsaved field drafts stay visible until they are saved or discarded. */
function propertyValues(
  saved: Record<string, unknown>,
  columns: readonly { name: string }[],
  drafts: ReadonlyMap<string, { value: unknown }>,
) {
  const values = { ...saved };
  for (const { name } of columns) {
    const draft = drafts.get(name);
    if (draft) values[name] = draft.value;
  }
  return values;
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
