import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import { PropertyPanel } from "@/features/properties/panel";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { usePageDetailContext } from "../hooks/page-detail-context";
import { handleError } from "../lib/errors";
import { PageAccessRecovery } from "./page-access-recovery";
import {
  PageIdentityHeader,
  PageIdentityHeaderSkeleton,
} from "./page-identity-header";
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
  const { page, schemaResult } = context;

  if (context.status === "loading") {
    return <PageDetailHeaderSkeleton actions={actions} />;
  }

  const metadataReadOnly =
    readOnly || (context.status !== "missing" && context.status !== "ready");
  const canCreateReadme = context.status === "missing" && !readOnly;
  const createReadme = () => {
    if (canCreateReadme) void context.createReadme().catch(handleError);
  };

  return (
    <div className={detailPageHeaderClassName}>
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
          void context.updateTitle(value).catch(handleError)
        }
        titleError={context.titleError}
        onIconChange={(value) =>
          void context.updateField("icon", value).catch(handleError)
        }
        onDescriptionChange={(value) =>
          void context.updateField("description", value).catch(handleError)
        }
        onCoverChange={(value) =>
          void context.updateCover(value).catch(handleError)
        }
        onBodyFocus={() => undefined}
        actions={actions}
        metadata={
          <>
            {metadataBefore}
            {page ? <PageSystemFields meta={page.meta} /> : null}
          </>
        }
        hideCover={!page}
        titleReadOnly={!page || metadataReadOnly}
        fallbackEmoji={!page ? context.fallbackIcon : null}
        onActivateIdentity={canCreateReadme ? createReadme : undefined}
        coverSize="compact"
        readOnly={metadataReadOnly}
      />
      <PageAccessRecovery
        error={context.writeError}
        onRetry={context.writeError ? context.retryWrites : undefined}
      />
      {showReadError && context.status === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{context.error}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              onClick={() => void context.reload().catch(handleError)}
            >
              {m.page_surface_save_retry()}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
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
            onSchemaChange={context.applySchema}
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
