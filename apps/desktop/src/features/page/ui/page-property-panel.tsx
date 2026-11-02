import { useMemo } from "react";
import type { PageSchemaResult } from "@/features/properties";
import {
  CollectionPropertyPanel,
  useCollectionSchemaPanel,
} from "@/features/properties/panel";
import { definePageSchemaProperties } from "../model/page-properties";
import type { Page } from "../model/types";

/**
 * The properties of a Page in a Collection: the shared property panel with
 * the schema extensions, built from the properties the Collection's columns
 * use. A value is written through `onValueChange`, the Page's field write.
 */
export function PagePropertyPanel({
  page,
  schemaResult,
  spacePath,
  projectPath,
  spaceId,
  presentation = "compact",
  readOnly = false,
  onOpenPath,
  onSchemaChange,
  onValueChange,
}: {
  /** The Page with its unsaved field drafts. */
  page: Page;
  schemaResult: PageSchemaResult;
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  presentation?: "full" | "compact";
  readOnly?: boolean;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
  onSchemaChange?: (result: PageSchemaResult | null) => void;
  onValueChange: (field: string, value: unknown) => Promise<void>;
}) {
  const schemaPanel = useCollectionSchemaPanel({
    spacePath,
    projectPath,
    spaceId,
    itemPath: page.path,
    schemaResult,
    values: page.meta.extra,
    onOpenPath,
    onSchemaChange,
  });
  const { actors, panelValues, schema } = schemaPanel;
  const item = useMemo(
    () => ({ ...page, meta: { ...page.meta, extra: panelValues } }),
    [page, panelValues],
  );
  const properties = useMemo(
    () =>
      definePageSchemaProperties(schema, {
        actorCandidates: actors,
        edit: readOnly
          ? undefined
          : (field) => ({
              getState: () => ({ status: "idle" }),
              update: (_page, value) => onValueChange(field, value),
            }),
      }),
    [actors, onValueChange, readOnly, schema],
  );

  return (
    <CollectionPropertyPanel
      properties={properties}
      item={item}
      layout={presentation === "full" ? "wide" : "default"}
      readOnly={readOnly}
      schemaPanel={schemaPanel}
    />
  );
}
