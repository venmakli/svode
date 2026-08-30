import type { ReactNode } from "react";
import { Database } from "lucide-react";
import { PropertyPanel } from "@/features/properties/panel";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { useEntryDetailContext } from "../hooks/entry-detail-context";
import { handleError } from "../lib/errors";
import {
  EntryIdentityHeader,
  EntryIdentityHeaderSkeleton,
} from "./entry-identity-header";
import { EntrySystemFields } from "./entry-system-fields";
import { TitleZone } from "./title-zone";

export function ScopeOwnerHeader({
  actions,
  readOnly = false,
}: {
  actions?: ReactNode;
  readOnly?: boolean;
}) {
  const context = useEntryDetailContext();
  const { entry, schemaResult } = context;

  if (context.status === "loading") {
    return <ScopeOwnerHeaderSkeleton actions={actions} />;
  }

  const canCreateReadme = context.status === "missing" && !readOnly;
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
          metadata={<EntrySystemFields meta={entry.meta} />}
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
      {entry && schemaResult?.schema.columns.length ? (
        <div className="max-w-5xl">
          <PropertyPanel
            key={`properties:${readOnly ? "view" : "edit"}`}
            spacePath={context.spacePath}
            projectPath={context.projectPath}
            spaceId={context.spaceId}
            filePath={context.readmePath}
            entryLabel={entry.meta.title}
            schemaResult={schemaResult}
            values={entry.meta.extra ?? {}}
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
      <EntryIdentityHeaderSkeleton actions={actions} />
    </div>
  );
}
