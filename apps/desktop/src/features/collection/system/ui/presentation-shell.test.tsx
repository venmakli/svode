import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineSystemCollectionPresentation } from "../model/runtime";
import type {
  SystemCollectionDetailController,
  SystemCollectionPresentationDescriptor,
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
    query: {},
    renderer: "list",
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
    ],
    renderRowContent: (row, context) => (
      <div className="flex items-center gap-2">
        {context.renderField("name")}
        {context.renderFieldControl("enabled")}
        {context.renderAction("refresh")}
        <button
          type="button"
          data-system-collection-interactive
          onClick={context.openDetail}
        >
          Detail
        </button>
        <span>{row.id}</span>
      </div>
    ),
    ...overrides,
  };
}

test("list shell renders owner content through field, control, action, and detail context", () => {
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
    />,
  );

  expect(markup.includes('data-system-collection-row="person:one"')).toBe(true);
  expect(markup.includes("data-field-value")).toBe(true);
  expect(markup.includes('data-system-collection-field="enabled"')).toBe(true);
  expect(markup.includes('data-system-collection-action="refresh"')).toBe(true);
  expect(
    markup.includes('data-system-collection-action-state="disabled"'),
  ).toBe(true);
  expect(markup.includes("Repository is read-only")).toBe(true);
  expect(markup.includes('data-system-collection-detail="true"')).toBe(true);
  expect(markup.includes("Row actions")).toBe(true);
});

test("cards shell uses the extracted responsive card layout without Entry", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      createDetailRequest: undefined,
      fields: [],
      renderer: "cards",
      rowActions: [],
      renderRowContent: (row) => <strong>{row.name}</strong>,
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
    />,
  );

  expect(markup.includes("repeat(auto-fill, minmax(248px, 1fr))")).toBe(true);
  expect(markup.includes('data-slot="card"')).toBe(true);
  expect(markup.includes("Review")).toBe(true);
  expect(markup.includes("entry")).toBe(false);
});

test("initial presentation uses renderer-specific extracted skeleton", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({ renderer: "cards" }),
    state: { phase: "initial" },
  });
  const markup = renderToStaticMarkup(
    <SystemCollectionPresentationShell
      instanceKey="space:root:context"
      presentation={presentation}
    />,
  );

  expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(40);
  expect(markup.includes('aria-hidden="true"')).toBe(true);
});

test("renderFieldControl fails closed for custom field semantics", () => {
  const presentation = defineSystemCollectionPresentation<TestRow>({
    descriptor: descriptor({
      createDetailRequest: undefined,
      rowActions: [],
      renderRowContent: (_row, context) => context.renderFieldControl("name"),
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
    />,
  );

  expect(markup.includes("standard editable property control")).toBe(true);
  expect(markup.includes("data-system-collection-diagnostic")).toBe(true);
});
