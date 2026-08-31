import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineCollectionCorePresentation } from "../model/runtime";
import { EMPTY_COLLECTION_CORE_QUERY } from "../model/query";
import type {
  CollectionCorePresentationDescriptor,
  CollectionCoreQueryState,
} from "../model/types";
import { CollectionCorePresentationShell } from "./presentation-shell";

interface TestRow {
  enabled: boolean;
  id: string;
  name: string;
}

function onQueryChange(_query: CollectionCoreQueryState) {}

function descriptor(
  overrides: Partial<CollectionCorePresentationDescriptor<TestRow>> = {},
): CollectionCorePresentationDescriptor<TestRow> {
  const nameProperty = {
    getValue: (row: TestRow) => row.name,
    key: "name",
    label: "Name",
    origin: "domain_specific" as const,
    owner: { featureId: "presentation-shell-test", kind: "feature" as const },
    semantics: {
      kind: "custom" as const,
      render: (value: unknown) => (
        <span data-property-value>{String(value)}</span>
      ),
    },
  };
  const enabledProperty = {
    capabilities: {
      edit: {
        getState: () => ({ status: "idle" as const }),
        update: async () => undefined,
      },
    },
    getValue: (row: TestRow) => row.enabled,
    key: "enabled",
    label: "Enabled",
    origin: "owner_defined" as const,
    owner: { featureId: "presentation-shell-test", kind: "feature" as const },
    semantics: {
      kind: "standard" as const,
      standard: { type: "boolean" as const },
    },
  };

  return {
    onActivate: () => undefined,
    properties: [nameProperty, enabledProperty],
    getRowId: (row) => row.id,
    id: "contributors",
    label: "Contributors",
    layout: {
      getTitle: (row) => row.id,
      kind: "list",
      visibleProperties: ["name", "enabled"],
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

test("list shell renders structured identity, property flow, context menu, and activation seam", () => {
  const presentation = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor(),
    state: {
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes('data-collection-core-row="person:one"')).toBe(true);
  expect(markup.includes("data-property-value")).toBe(true);
  expect(markup.includes('data-collection-core-property="enabled"')).toBe(true);
  expect(markup.includes('data-collection-activatable="true"')).toBe(true);
  expect(markup.includes('data-slot="context-menu-trigger"')).toBe(true);
  expect(markup.includes("Row actions")).toBe(false);
  expect(markup.includes('role="list"')).toBe(true);
  expect(markup.includes('role="listitem"')).toBe(true);
  expect(markup.includes('aria-label="Contributors"')).toBe(true);
  expect(markup.includes('role="listbox"')).toBe(false);
  expect(markup.includes('role="option"')).toBe(false);
});

test("structured Gallery uses the full responsive geometry and properties without Page", () => {
  const presentation = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({
      onActivate: undefined,
      layout: {
        cardSize: "medium",
        density: "compact",
        getDescription: () => "Static artifact",
        getTitle: (row) => row.name,
        kind: "gallery",
        visibleProperties: ["name"],
      },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [{ enabled: false, id: "skill:review", name: "Review" }],
    },
  });
  const markup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:context"
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("repeat(auto-fill, minmax(240px, 1fr))")).toBe(true);
  expect(markup.includes("max-width")).toBe(false);
  expect(markup.includes('data-slot="card"')).toBe(true);
  expect(markup.includes('data-size="sm"')).toBe(true);
  expect(markup.includes("Review")).toBe(true);
  expect(markup.includes("Static artifact")).toBe(true);
  expect(markup.includes("data-property-value")).toBe(true);
  expect(markup.includes("entry")).toBe(false);
  expect(markup.includes("aspect-video")).toBe(false);
});

test("ready presentation renders the controlled frontend query snapshot", () => {
  const presentation = defineCollectionCorePresentation<TestRow>({
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
    <CollectionCorePresentationShell
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
  const presentation = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({
      layout: {
        cardSize: "medium",
        density: "compact",
        getTitle: (row) => row.name,
        kind: "gallery",
        visibleProperties: [],
      },
    }),
    state: { phase: "initial" },
  });
  const markup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:context"
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(32);
  expect(markup.includes('aria-hidden="true"')).toBe(true);
  expect(markup.includes("repeat(auto-fill, minmax(240px, 1fr))")).toBe(true);
  expect(markup.includes("max-width")).toBe(false);
  expect(markup.includes("aspect-video")).toBe(false);
  expect(markup.includes('data-size="sm"')).toBe(true);
});

test("structured list layout fails closed for an unknown visible property", () => {
  const presentation = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({
      onActivate: undefined,
      layout: {
        getTitle: (row) => row.name,
        kind: "list",
        visibleProperties: ["missing"],
      },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("unknown visible property")).toBe(true);
  expect(markup.includes("data-collection-core-blocking-error")).toBe(true);
});

test("ready presentation keeps stale rows visible with diagnostics and no refresh status", () => {
  const presentation = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({
      rowActions: [],
    }),
    state: {
      attention: <span>Review identity</span>,
      diagnostics: [<span key="source">Git history is incomplete</span>],
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const markup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:actors"
      presentation={presentation}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(markup.includes("Ilya")).toBe(true);
  expect(markup.includes("Updating")).toBe(false);
  expect(markup.includes("data-collection-core-refreshing")).toBe(false);
  expect(markup.includes("data-collection-core-attention")).toBe(true);
  expect(markup.includes("Review identity")).toBe(true);
  expect(markup.includes("data-collection-core-diagnostics")).toBe(true);
  expect(markup.includes("Git history is incomplete")).toBe(true);
});

test("source-empty is resolved after fixed predicate and uses owner content or neutral fallback", () => {
  const neutral = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({
      query: { fixedPredicate: (row) => row.enabled },
      rowActions: [],
    }),
    state: {
      phase: "ready",
      rows: [{ enabled: false, id: "hidden", name: "Hidden" }],
    },
  });
  const owner = defineCollectionCorePresentation<TestRow>({
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
    <CollectionCorePresentationShell
      instanceKey="space:root:actors"
      presentation={neutral}
      query={{ filters: [], search: "hidden", sort: [] }}
      onQueryChange={onQueryChange}
    />,
  );
  const ownerMarkup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:actors-owner-empty"
      presentation={owner}
      query={EMPTY_COLLECTION_CORE_QUERY}
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
  const presentation = defineCollectionCorePresentation<TestRow>({
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
    <CollectionCorePresentationShell
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
  const blocked = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({ id: "broken", rowActions: [] }),
    state: {
      error: "Descriptor failed",
      phase: "blocking_error",
    },
  });
  const ready = defineCollectionCorePresentation<TestRow>({
    descriptor: descriptor({ id: "healthy", rowActions: [] }),
    state: {
      phase: "ready",
      rows: [{ enabled: true, id: "person:one", name: "Ilya" }],
    },
  });
  const blockedMarkup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:actors"
      presentation={blocked}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );
  const readyMarkup = renderToStaticMarkup(
    <CollectionCorePresentationShell
      instanceKey="space:root:actors"
      presentation={ready}
      query={EMPTY_COLLECTION_CORE_QUERY}
      onQueryChange={onQueryChange}
    />,
  );

  expect(blockedMarkup.includes("Descriptor failed")).toBe(true);
  expect(blockedMarkup.includes("data-collection-core-blocking-error")).toBe(
    true,
  );
  expect(readyMarkup.includes("Ilya")).toBe(true);
  expect(readyMarkup.includes("Descriptor failed")).toBe(false);
  expect(readyMarkup.includes("data-collection-core-create")).toBe(false);
});
