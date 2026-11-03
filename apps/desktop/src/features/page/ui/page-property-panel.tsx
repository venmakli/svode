import { useMemo, type ReactNode } from "react";
import type { PageSchemaResult } from "@/features/properties";
import {
  CollectionPropertyPanel,
  useCollectionSchemaPanel,
  type CollectionPropertyPanelConflict,
} from "@/features/properties/panel";
import { ConflictProblemAlert } from "@/features/changes";
import { usePageMerge } from "../hooks/use-page-merge";
import type { PageMergeWrite } from "../model/page-merge";
import { pageMergeEntries, pageWithMerge } from "../model/page-merge-view";
import { definePageSchemaProperties } from "../model/page-properties";
import type { Page } from "../model/types";

interface PagePropertyPanelProps {
  /** The Page with its unsaved field drafts. */
  page: Page;
  /** None for a Page outside a Collection: only its conflict mode shows. */
  schemaResult: PageSchemaResult | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  presentation?: "full" | "compact";
  readOnly?: boolean;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
  onSchemaChange?: (result: PageSchemaResult | null) => void;
  onValueChange: (field: string, value: unknown) => Promise<void>;
}

/**
 * The properties of a Page: the shared property panel with the schema
 * extensions of its Collection, built from the properties the Collection's
 * columns use. A value is written through `onValueChange`, the Page's field
 * write. While the frontmatter of the Page is in conflict the panel is in
 * conflict mode (DF-292): the merged values read only, and each disputed
 * property decided by a side or by a value of its control, which the editor
 * writes with the text of the Page.
 */
export function PagePropertyPanel(props: PagePropertyPanelProps) {
  const merge = usePageMerge(props.spacePath, props.page.path);
  const mergeState = merge.state?.merge.type === "merged" ? merge.state : null;
  const conflict = useMemo<CollectionPropertyPanelConflict<Page> | undefined>(
    () =>
      mergeState
        ? {
            disputed: pageMergeEntries(props.page, mergeState),
            accepted: mergeState.accepted,
            pending: mergeState.write.status === "writing",
            problem: writeProblem(mergeState.write),
            readOnly: props.readOnly ?? false,
            onChoose: merge.choose,
            onReopen: merge.reopen,
            onAccept: merge.accept,
          }
        : undefined,
    [
      merge.accept,
      merge.choose,
      merge.reopen,
      mergeState,
      props.page,
      props.readOnly,
    ],
  );
  const page = useMemo(
    () => (mergeState ? pageWithMerge(props.page, mergeState) : props.page),
    [mergeState, props.page],
  );
  const merged = conflict ? { conflict, setValue: merge.setValue } : null;
  if (!props.schemaResult) {
    return merged ? (
      <CollectionPropertyPanel
        conflict={merged.conflict}
        properties={[]}
        item={page}
        readOnly={props.readOnly}
      />
    ) : null;
  }
  return (
    <SchemaPagePropertyPanel
      {...props}
      page={page}
      schemaResult={props.schemaResult}
      merged={merged}
    />
  );
}

function SchemaPagePropertyPanel({
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
  merged,
}: PagePropertyPanelProps & {
  schemaResult: PageSchemaResult;
  merged: {
    conflict: CollectionPropertyPanelConflict<Page>;
    setValue: (field: string, value: unknown) => Promise<void>;
  } | null;
}) {
  const disputed = merged?.conflict.disputed;
  // A disputed key outside the schema shows as a disputed property, not as a
  // value the schema does not declare.
  const values = useMemo(() => {
    if (!disputed) return page.meta.extra;
    const columns = new Set(
      schemaResult.schema.columns.map(({ name }) => name),
    );
    return Object.fromEntries(
      Object.entries(page.meta.extra).filter(
        ([key]) =>
          columns.has(key) || !disputed.some((entry) => entry.key === key),
      ),
    );
  }, [disputed, page.meta.extra, schemaResult.schema.columns]);
  const schemaPanel = useCollectionSchemaPanel({
    spacePath,
    projectPath,
    spaceId,
    itemPath: page.path,
    schemaResult,
    values,
    onOpenPath,
    onSchemaChange,
  });
  const { actors, panelValues, schema } = schemaPanel;
  const item = useMemo(
    () => ({ ...page, meta: { ...page.meta, extra: panelValues } }),
    [page, panelValues],
  );
  const setMergeValue = merged?.setValue;
  const properties = useMemo(
    () =>
      definePageSchemaProperties(schema, {
        actorCandidates: actors,
        edit: readOnly
          ? undefined
          : (field) => {
              // In conflict mode only a disputed property is edited: its
              // value decides it.
              if (setMergeValue)
                return disputed?.some((entry) => entry.key === field)
                  ? {
                      getState: () => ({ status: "idle" }),
                      update: (_page, value) => setMergeValue(field, value),
                    }
                  : undefined;
              return {
                getState: () => ({ status: "idle" }),
                update: (_page, value) => onValueChange(field, value),
              };
            },
      }),
    [actors, disputed, onValueChange, readOnly, schema, setMergeValue],
  );

  return (
    <CollectionPropertyPanel
      conflict={merged?.conflict}
      properties={properties}
      item={item}
      layout={presentation === "full" ? "wide" : "default"}
      readOnly={readOnly}
      schemaPanel={schemaPanel}
    />
  );
}

/** Why the last write of the decisions did not go: at the panel, the decisions stay. */
function writeProblem(write: PageMergeWrite): ReactNode {
  if (write.status === "refused")
    return (
      <ConflictProblemAlert
        problem={{ kind: "finding", finding: write.finding }}
      />
    );
  if (write.status === "failed")
    return (
      <ConflictProblemAlert
        problem={{ kind: "failed", message: write.message }}
      />
    );
  return null;
}
