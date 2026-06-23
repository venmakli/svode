import type { ReactNode } from "react";
import { Database } from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import {
  EntryIdentityHeader,
  PlateDocumentEditor,
  TitleZone,
} from "@/features/editor";
import type { Entry, EntryCover } from "@/features/entry";
import { EntrySystemFields } from "@/features/entry/detail";
import { PropertyPanel } from "@/features/properties/panel";
import type { EntrySchemaResult } from "@/features/properties";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";

interface CollectionDocumentHeaderProps {
  hasReadme: boolean;
  title: string;
  icon: string | null;
  description: string;
  cover: EntryCover | null;
  projectPath?: string | null;
  spacePath: string;
  readmePath: string;
  spaceId: string;
  entry: Entry | null;
  propertiesSchema: EntrySchemaResult | null;
  actions: ReactNode;
  onOpenPath: (path: string) => void;
  onCreateReadmeForIdentity: () => void;
  onUpdateIdentity: (
    field: "title" | "icon" | "description",
    value: unknown,
  ) => void;
  onUpdateCover: (cover: EntryCover | null) => void;
  onReadmePropertyChange: (field: string, value: unknown) => Promise<void>;
  onBodyFocus: () => void;
}

export function CollectionDocumentHeader({
  hasReadme,
  title,
  icon,
  description,
  cover,
  projectPath,
  spacePath,
  readmePath,
  spaceId,
  entry,
  propertiesSchema,
  actions,
  onOpenPath,
  onCreateReadmeForIdentity,
  onUpdateIdentity,
  onUpdateCover,
  onReadmePropertyChange,
  onBodyFocus,
}: CollectionDocumentHeaderProps) {
  const hasHeaderProperties = Boolean(
    propertiesSchema && propertiesSchema.schema.columns.length > 0 && entry,
  );

  return (
    <div className={detailPageHeaderClassName}>
      <div>
        {hasReadme ? (
          <EntryIdentityHeader
            title={title}
            icon={icon}
            description={description}
            cover={cover}
            projectPath={projectPath ?? null}
            spacePath={spacePath}
            documentPath={readmePath}
            onTitleChange={(value) => onUpdateIdentity("title", value)}
            onIconChange={(value) => onUpdateIdentity("icon", value)}
            onDescriptionChange={(value) =>
              onUpdateIdentity("description", value)
            }
            onCoverChange={onUpdateCover}
            onBodyFocus={onBodyFocus}
            titleClassName={actions ? "max-w-none" : "max-w-4xl"}
            actions={actions}
            metadata={entry ? <EntrySystemFields meta={entry.meta} /> : null}
            coverSize={actions ? "compact" : "default"}
          />
        ) : (
          <div className="max-w-4xl">
            <TitleZone
              title={title}
              icon={null}
              description=""
              readOnly
              hideDescription
              fallbackIcon={Database}
              onActivateIdentity={onCreateReadmeForIdentity}
              onTitleChange={onCreateReadmeForIdentity}
              onIconChange={onCreateReadmeForIdentity}
              onDescriptionChange={() => undefined}
              onBodyFocus={() => undefined}
            />
          </div>
        )}
      </div>
      {hasHeaderProperties && entry && propertiesSchema ? (
        <div className="max-w-5xl">
          <PropertyPanel
            spacePath={spacePath}
            projectPath={projectPath}
            spaceId={spaceId}
            filePath={readmePath}
            schemaResult={propertiesSchema}
            values={entry.meta.extra ?? {}}
            mode="full"
            onOpenPath={onOpenPath}
            onValueChange={onReadmePropertyChange}
          />
        </div>
      ) : null}
    </div>
  );
}

interface CollectionDocumentTabProps {
  readmePath: string;
  spaceId: string;
  spacePath: string;
  projectPath?: string | null;
  entry: Entry | null;
  onDocumentPathChange: (path: string) => void;
}

export function CollectionDocumentTab({
  readmePath,
  spaceId,
  spacePath,
  projectPath,
  entry,
  onDocumentPathChange,
}: CollectionDocumentTabProps) {
  return (
    <TabsContent value="document" className="flex-none">
      <PlateDocumentEditor
        bodyOnly
        pageScroll
        documentPath={readmePath}
        documentSpaceId={spaceId}
        spacePath={spacePath}
        projectPath={projectPath}
        bodyOnlyMeta={entry?.meta ?? null}
        initialEntry={entry}
        initialEntrySpacePath={spacePath}
        onDocumentPathChange={onDocumentPathChange}
      />
    </TabsContent>
  );
}
