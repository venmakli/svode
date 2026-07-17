import type { ReactNode } from "react";
import { Database } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PropertyPanel } from "@/features/properties/panel";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { useEntryDetailContext } from "../hooks/entry-detail-context";
import { handleError } from "../lib/errors";
import { EntryIdentityHeader } from "./entry-identity-header";
import { EntrySystemFields } from "./entry-system-fields";
import { TitleZone } from "./title-zone";

export function ScopeOwnerHeader({ actions }: { actions?: ReactNode }) {
  const context = useEntryDetailContext();
  const { entry, schemaResult } = context;

  if (context.status === "loading") {
    return <ScopeOwnerHeaderSkeleton />;
  }

  const canCreateReadme = context.status === "missing";
  const createReadme = () => {
    if (canCreateReadme) void context.createReadme().catch(handleError);
  };

  return (
    <div className={detailPageHeaderClassName}>
      {entry ? (
        <EntryIdentityHeader
          title={entry.meta.title}
          icon={entry.meta.icon}
          description={entry.meta.description ?? ""}
          cover={entry.meta.cover ?? null}
          projectPath={context.projectPath}
          spacePath={context.spacePath}
          documentPath={context.readmePath}
          onTitleChange={(value) =>
            void context.updateField("title", value).catch(handleError)
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
          metadata={<EntrySystemFields meta={entry.meta} />}
          coverSize="compact"
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
      {entry && schemaResult?.schema.columns.length ? (
        <div className="max-w-5xl">
          <PropertyPanel
            spacePath={context.spacePath}
            projectPath={context.projectPath}
            spaceId={context.spaceId}
            filePath={context.readmePath}
            schemaResult={schemaResult}
            values={entry.meta.extra ?? {}}
            mode="full"
            onOpenPath={context.onOpenPath}
            onValueChange={context.updateField}
          />
        </div>
      ) : null}
    </div>
  );
}

function ScopeOwnerHeaderSkeleton() {
  return (
    <div className={detailPageHeaderClassName} aria-hidden="true">
      <Skeleton className="h-44 min-h-32 max-h-48 w-full" />
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Skeleton className="size-9 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-8 w-64 max-w-full" />
            <Skeleton className="h-4 w-40 max-w-2/3" />
          </div>
        </div>
        <Skeleton className="h-8 w-24 shrink-0" />
      </div>
    </div>
  );
}
