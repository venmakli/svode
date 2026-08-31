import type { ReactNode } from "react";
import { Database } from "lucide-react";
import { PropertyPanel } from "@/features/properties/panel";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { usePageDetailContext } from "@/features/page/scope-surface";
import {
  handleError,
  PageIdentityHeader,
  PageIdentityHeaderSkeleton,
  PageSystemFields,
  TitleZone,
} from "@/features/page/detail";

export function ScopeOwnerHeader({
  actions,
  readOnly = false,
}: {
  actions?: ReactNode;
  readOnly?: boolean;
}) {
  const context = usePageDetailContext();
  const { page, schemaResult } = context;

  if (context.status === "loading") {
    return <ScopeOwnerHeaderSkeleton actions={actions} />;
  }

  const canCreateReadme = context.status === "missing" && !readOnly;
  const createReadme = () => {
    if (canCreateReadme) void context.createReadme().catch(handleError);
  };

  return (
    <div className={detailPageHeaderClassName}>
      {page ? (
        <PageIdentityHeader
          title={page.meta.title}
          icon={page.meta.icon}
          description={page.meta.description ?? ""}
          cover={page.meta.cover ?? null}
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
          metadata={<PageSystemFields meta={page.meta} />}
          coverSize="compact"
          readOnly={readOnly}
        />
      ) : (
        <div className="max-w-4xl">
          <TitleZone
            title={context.fallbackTitle}
            icon={null}
            description=""
            readOnly
            hideDescription
            fallbackIcon={Database}
            fallbackEmoji={context.fallbackIcon}
            onActivateIdentity={createReadme}
            onTitleChange={createReadme}
            onIconChange={createReadme}
            onDescriptionChange={() => undefined}
            onBodyFocus={() => undefined}
          />
        </div>
      )}
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
