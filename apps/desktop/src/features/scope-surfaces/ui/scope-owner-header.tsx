import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import { PropertyPanel } from "@/features/properties/panel";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import {
  PageAccessRecovery,
  usePageDetailContext,
} from "@/features/page/scope-surface";
import {
  handleError,
  PageIdentityHeader,
  PageIdentityHeaderSkeleton,
  PageSystemFields,
} from "@/features/page/detail";

export function ScopeOwnerHeader({
  actions,
  readOnly = false,
  showReadError = true,
}: {
  actions?: ReactNode;
  readOnly?: boolean;
  showReadError?: boolean;
}) {
  const context = usePageDetailContext();
  const { page, schemaResult } = context;

  if (context.status === "loading") {
    return <ScopeOwnerHeaderSkeleton actions={actions} />;
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
        pagePath={context.readmePath}
        onTitleChange={(value) =>
          void context
            .updateField("title", value, { flush: true })
            .catch(handleError)
        }
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
        metadata={page ? <PageSystemFields meta={page.meta} /> : undefined}
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
            filePath={context.readmePath}
            pageLabel={page.meta.title}
            schemaResult={schemaResult}
            values={page.meta.extra ?? {}}
            mode="full"
            readOnly={readOnly}
            onOpenPath={context.onOpenPath}
            onValueChange={context.updateField}
          />
        </div>
      ) : null}
    </div>
  );
}

function ScopeOwnerHeaderSkeleton({ actions }: { actions?: ReactNode }) {
  return (
    <div
      className={detailPageHeaderClassName}
      aria-hidden={actions ? undefined : true}
    >
      <PageIdentityHeaderSkeleton actions={actions} />
    </div>
  );
}
