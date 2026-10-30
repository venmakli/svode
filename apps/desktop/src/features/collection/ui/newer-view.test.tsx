import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CircleFadingArrowUp, Table } from "lucide-react";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import type { CollectionView, UseViewQueryResult } from "../query/model";
import type { PageCollectionPresentationDescriptor } from "../persisted/page-collection-definition";
import { isNewerView } from "../lib/utils";
import { CollectionPresentation } from "./collection-presentation";
import { ColumnHeader } from "./table/table-shell";
import { ViewActionBar } from "./view-action-bar";
import { viewIcon } from "./view-icons";
import {
  ViewSettingsMainFooter,
  ViewSettingsMainPane,
} from "./view-settings/main-pane";

const ALERT_TITLE = "This view was created by a newer Svode version.";

const views: CollectionView[] = [
  { name: "Table", type: "table" },
  { name: "Timeline", type: "timeline" as "table" },
  {
    name: "Between",
    type: "table",
    filter: [{ field: "Estimate", op: "between" as "eq", value: [1, 2] }],
  },
];

const schema: CollectionSchema = normalizeSchema({
  columns: [{ name: "Estimate", type: "number" }],
  views,
  newer_svode: { columns: [], views: ["Timeline", "Between"] },
});

const query = {
  merged: { name: "", type: "table", filter: [], sort: [], groupBy: null },
} as unknown as UseViewQueryResult;

test("views a newer Svode version created or depends on are recognized", () => {
  expect(views.map((view) => isNewerView(schema, view))).toEqual([
    false,
    true,
    true,
  ]);
  // A type this version does not know is newer without the marker too.
  expect(isNewerView({ columns: [] }, views[1])).toBe(true);
  expect(viewIcon(views[0])).toBe(Table);
  expect(viewIcon(views[1])).toBe(CircleFadingArrowUp);
  expect(viewIcon(views[2])).toBe(Table);
});

test("a newer view shows the alert in place of its items", () => {
  for (const view of views.slice(1)) {
    const markup = renderToStaticMarkup(
      <CollectionPresentation
        mode="schema-backed"
        descriptor={{} as PageCollectionPresentationDescriptor}
        readOnly={false}
        view={view}
        query={query}
        schema={schema}
        collectionPath="tasks"
        spacePath="/repo"
        searchQuery=""
        refreshToken={0}
        createRequest={{ signal: 0, asFolder: false }}
        onClearSearch={() => undefined}
        onOpenNestedPeek={() => undefined}
        onOpenNestedCollection={() => undefined}
        onOpenFullPage={() => undefined}
        onOpenPath={() => undefined}
        onOpenRelationTarget={() => undefined}
        onSchemaChange={() => undefined}
        onUpdateView={async () => undefined}
        onCreatePage={async () => {
          throw new Error("not called");
        }}
      />,
    );
    expect(markup.includes('role="alert"')).toBe(true);
    expect(markup.includes(ALERT_TITLE)).toBe(true);
    expect(markup.includes("Update Svode to open it.")).toBe(true);
  }
});

test("the action bar of a newer view keeps only its settings for rename and delete", () => {
  const render = (view: CollectionView) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ViewActionBar
          searchOpen={false}
          searchQuery=""
          settingsOpen={false}
          settingsPane="main"
          activeView={view}
          renameValue={view.name}
          schema={schema}
          query={query}
          collectionPath="tasks"
          spacePath="/repo"
          readOnly
          onSearchOpenChange={() => undefined}
          onSearchQueryChange={() => undefined}
          onSettingsOpenChange={() => undefined}
          onSettingsPaneChange={() => undefined}
          onRenameValueChange={() => undefined}
          onRename={async () => undefined}
          onUpdateView={async () => undefined}
          onDuplicateView={async () => undefined}
          onDeleteViewRequest={() => undefined}
          onSchemaChange={() => undefined}
          autoConfigForType={() => ({})}
          onCreatePage={() => undefined}
          onLoadTemplates={async () => []}
          onCreateTemplate={async () => undefined}
          onInstantiateTemplate={async () => undefined}
          onEditTemplate={async () => undefined}
          onSetDefaultTemplate={async () => undefined}
          onDuplicateTemplate={async () => undefined}
          onDeleteTemplate={async () => undefined}
          onReorderTemplates={async () => undefined}
        />
      </TooltipProvider>,
    );

  const known = render(views[0]);
  const newer = render(views[1]);
  expect(known.includes("Filter")).toBe(true);
  expect(known.includes("Sort")).toBe(true);
  expect(newer.includes("Filter")).toBe(false);
  expect(newer.includes("Sort")).toBe(false);
  expect(newer.includes("Search")).toBe(false);
  expect(newer.includes("View settings")).toBe(true);
});

test("the settings of a newer view offer rename and delete, not duplicate", () => {
  const main = (newer: boolean) =>
    renderToStaticMarkup(
      <ViewSettingsMainPane
        view={views[1]}
        newer={newer}
        renameValue="Timeline"
        schema={schema}
        query={query}
        onRenameValueChange={() => undefined}
        onRename={async () => undefined}
        openPane={() => undefined}
        updateTypeSetting={() => undefined}
      />,
    );
  expect(main(true).includes('value="Timeline"')).toBe(true);
  expect(main(true).includes("Filter")).toBe(false);
  expect(main(false).includes("Filter")).toBe(true);

  const footer = renderToStaticMarkup(
    <ViewSettingsMainFooter
      onDuplicate={null}
      onDeleteRequest={() => undefined}
    />,
  );
  expect(footer.includes("Duplicate")).toBe(false);
  expect(footer.includes("Remove")).toBe(true);
});

test("the header of a newer property has no menu, even in read-only", () => {
  const header = (newer: boolean, readOnly: boolean) =>
    renderToStaticMarkup(
      <ColumnHeader
        label="Score"
        icon={CircleFadingArrowUp}
        open={false}
        readOnly={readOnly}
        newer={newer}
        onOpenChange={() => undefined}
      >
        <ColumnMenuStub />
      </ColumnHeader>,
    );

  for (const readOnly of [false, true]) {
    const markup = header(true, readOnly);
    expect(markup.includes('data-newer-property="Score"')).toBe(true);
    expect(markup.includes("disabled")).toBe(false);
    expect(markup.includes("data-column-menu")).toBe(false);
    expect(markup.includes("lucide-ellipsis-vertical")).toBe(false);
  }
  expect(header(false, false).includes("lucide-ellipsis-vertical")).toBe(true);
});

function ColumnMenuStub({ trigger }: { trigger?: ReactNode }) {
  return <span data-column-menu>{trigger}</span>;
}
