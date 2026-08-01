import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineSystemCollectionPresentation } from "../model/runtime";
import { EMPTY_SYSTEM_COLLECTION_QUERY } from "../model/query";
import type {
  SystemCollectionDetailController,
  SystemCollectionPresentationDescriptor,
  SystemCollectionQueryState,
} from "../model/types";
import { SystemCollectionPresentationShell } from "./presentation-shell";

interface TestRow {
  enabled: boolean;
  id: string;
  name: string;
}

const detailController: SystemCollectionDetailController = {
  close: async () => true,
  open: async () => true,
  prepareForNavigation: async () => true,
};

function onQueryChange(_query: SystemCollectionQueryState) {}

function descriptor(
  overrides: Partial<SystemCollectionPresentationDescriptor<TestRow>> = {},
): SystemCollectionPresentationDescriptor<TestRow> {
  const nameField = {
    getValue: (row: TestRow) => row.name,
    key: "name",
    label: "Name",
    valueSemantics: {
      kind: "custom" as const,
      render: (value: unknown) => <span data-field-value>{String(value)}</span>,
    },
  };
  const enabledField = {
    edit: {
      getState: () => ({ status: "idle" as const }),
      update: async () => undefined,
    },
    getValue: (row: TestRow) => row.enabled,
    key: "enabled",
    label: "Enabled",
    valueSemantics: {
      kind: "property" as const,
      column: { name: "enabled", type: "checkbox" as const },
    },
  };

  return {
    createDetailRequest: (row) => ({
      content: row.name,
      description: "Actor detail",
      title: row.name,
    }),
    fields: [nameField, enabledField],
    getRowId: (row) => row.id,
    id: "contributors",
    label: "Contributors",
    layout: {
      getTitle: (row) => row.id,
      kind: "list",
      visibleFields: ["name", "enabled"],
    },
    query: {},
    rowActions: [
      {
        getState: () => ({
          reason: "Repository is read-only",
          status: "disabled",
        }),
        id: "refresh",
        label: "Refresh",
        run: () => undefined,
      },
      {
        getState: () => ({ status: "pending" }),
        id: "sync",
        label: "Sync",
        run: () => undefined,
      },
      {
        getState: () => ({
          message: "Previous retry failed",
          status: "error",
        }),
        id: "retry",
        label: "Retry",
        run: () => undefined,
      },
    ],
    ...overrides,
  };
}

test("list shell renders structured identity, property flow, context menu, and detail seam", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor(),
    state: {
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      detailController={detailController}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes('data-system-collection-row="person:one"')).toBe(true);
  expect(markup.includes("data-field-value")).toBe(true);
  expect(markup.includes('data-system-collection-field="enabled"')).toBe(true);
  expect(markup.includes('data-system-collection-detail="true"')).toBe(true);
  expect(markup.includes('data-slot="context-menu-trigger"')).toBe(true);
  expect(markup.includes("Row actions")).toBe(false);
  expect(markup.includes('role="list"')).toBe(true);
  expect(markup.includes('role="listitem"')).toBe(true);
  expect(markup.includes('aria-label="Contributors"')).toBe(true);
  expect(markup.includes('role="listbox"')).toBe(false);
  expect(markup.includes('role="option"')).toBe(false);
});

test("cards shell uses the extracted responsive card layout without Entry", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      createDetailRequest: undefined,
      fields: [],
      layout: {
        kind: "cards",
        renderCardContent: (row) => <strong>{row.name}</strong>,
      },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [{ enabled: false, id: "skill:review", name: "Review" }],
    },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:context"
      presentation={presentation}
      cardWidth={248}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("repeat(auto-fill, minmax(248px, 1fr))")).toBe(true);
  expect(markup.includes('data-slot="card"')).toBe(true);
  expect(markup.includes("Review")).toBe(true);
  expect(markup.includes("entry")).toBe(false);
});

test("ready presentation renders the controlled frontend query snapshot", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      query: { getSearchText: (row) => row.name },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [
        { enabled: true, id: "person:one", name: "Ilya" },
        { enabled: true, id: "person:two", name: "Ada" },
      ],
    },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={{ filters: [], search: " ada ", sort: [] }}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("Ada")).toBe(true);
  expect(markup.includes("Ilya")).toBe(false);
});

test("initial presentation uses renderer-specific extracted skeleton", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      layout: {
        kind: "cards",
        renderCardContent: (row) => row.name,
      },
    }),
    state: { phase: "initial" },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:context"
      presentation={presentation}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(40);
  expect(markup.includes('aria-hidden="true"')).toBe(true);
});

test("structured list layout fails closed for an unknown visible field", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      createDetailRequest: undefined,
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleFields: ["missing"],
      },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("unknown visible field")).toBe(true);
  expect(markup.includes("data-system-collection-blocking-error")).toBe(true);
});

test("ready presentation keeps stale rows visible with refresh, diagnostics, and attention", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      rowActions: [],
    }),
    state: {
      attention: <span>Review identity</span>,
      diagnostics: [<span key="source">Git history is incomplete</span>],
      phase: "ready",
      refreshing: true,
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("Ilya")).toBe(true);
  expect(markup.includes("Updating")).toBe(true);
  expect(markup.includes("data-system-collection-refreshing")).toBe(true);
  expect(markup.includes("data-system-collection-attention")).toBe(true);
  expect(markup.includes("Review identity")).toBe(true);
  expect(markup.includes("data-system-collection-diagnostics")).toBe(true);
  expect(markup.includes("Git history is incomplete")).toBe(true);
});

test("source-empty is resolved after fixed predicate and uses owner content or neutral fallback", () => {
  const neutral = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      query: { fixedPredicate: (row) => row.enabled },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [{ enabled: false, id: "hidden", name: "Hidden" }],
    },
  });
  const owner = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      query: { fixedPredicate: (row) => row.enabled },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [],
      sourceEmpty: <div>Connect a repository to discover contributors</div>,
    },
  });
  const neutralMarkup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={neutral}
      query={{ filters: [], search: "hidden", sort: [] }}
      onQueryChange={onQueryChange}
    />,
  );
  const ownerMarkup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors-owner-empty"
      presentation={owner}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(neutralMarkup.includes("No items yet")).toBe(true);
  expect(neutralMarkup.includes("No results")).toBe(false);
  expect(neutralMarkup.includes("Hidden")).toBe(false);
  expect(
    ownerMarkup.includes("Connect a repository to discover contributors"),
  ).toBe(true);
  expect(ownerMarkup.includes("No items yet")).toBe(false);
});

test("query-empty has a common reset action while source rows still exist", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      query: { getSearchText: (row) => row.name },
      rowActions: [],
    }),
    state: {
      attention: <span>Catalog is read-only</span>,
      diagnostics: [<span key="partial">One source was unavailable</span>],
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={{ filters: [], search: "Ada", sort: [] }}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("No results")).toBe(true);
  expect(markup.includes("Reset query")).toBe(true);
  expect(markup.includes("Ilya")).toBe(false);
  expect(markup.includes("Catalog is read-only")).toBe(true);
  expect(markup.includes("One source was unavailable")).toBe(true);
});

test("read-only presentation omits create and blocking errors stay presentation-local", () => {
  const blocked = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({ id: "broken", rowActions: [] }),
    state: {
      error: "Descriptor failed",
      phase: "blocking_error",
    },
  });
  const ready = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({ id: "healthy", rowActions: [] }),
    state: {
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const blockedMarkup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={blocked}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );
  const readyMarkup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:actors"
      presentation={ready}
      query={EMPTY_SYSTEM_COLLECTION_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(blockedMarkup.includes("Descriptor failed")).toBe(true);
  expect(blockedMarkup.includes("data-system-collection-blocking-error")).toBe(
    true,
  );
  expect(readyMarkup.includes("Ilya")).toBe(true);
  expect(readyMarkup.includes("Descriptor failed")).toBe(false);
  expect(readyMarkup.includes("data-system-collection-create")).toBe(false);
});
