import { expect, test } from "bun:test";

import type {
  SystemCollectionFieldDescriptor,
  SystemCollectionInstance,
  SystemCollectionPresentationDescriptor,
  SystemCollectionPresentationInstance,
} from "./types";
import {
  SystemCollectionInstanceRegistry,
  resolveSystemCollectionPresentationId,
  validateSystemCollectionInstance,
} from "./instance-runtime";
import {
  defineSystemCollectionPresentation,
  readSystemCollectionPresentationRuntime,
} from "./runtime";

interface TestRow {
  id: string;
  name: string;
}

function testDescriptor(
  overrides: Partial<SystemCollectionPresentationDescriptor<TestRow>> = {},
): SystemCollectionPresentationDescriptor<TestRow> {
  return {
    fields: [],
    getRowId: (row) => row.id,
    id: "people",
    label: "People",
    query: {},
    renderer: "list",
    renderRowContent: (row) => row.name,
    ...overrides,
  };
}

function testPresentation(
  overrides: Partial<SystemCollectionPresentationInstance<TestRow>> = {},
) {
  return defineSystemCollectionPresentation<TestRow>({
    descriptor: testDescriptor(),
    state: {
      phase: "ready",
      rows: [{ id: "person:one", name: "One" }],
    },
    ...overrides,
  });
}

test("typed presentation factory erases heterogeneous row models", () => {
  interface SkillRow {
    path: string;
  }

  const people = testPresentation();
  const skills = defineSystemCollectionPresentation<SkillRow>({
    descriptor: {
      fields: [],
      getRowId: (row) => row.path,
      id: "skills",
      label: "Skills",
      query: {},
      renderer: "cards",
      renderRowContent: (row) => row.path,
    },
    state: {
      phase: "ready",
      rows: [{ path: "skills/review/SKILL.md" }],
    },
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "people",
    instanceKey: "space:root:actors",
    presentations: [people, skills],
    stateScope: "session",
  };

  expect(validateSystemCollectionInstance(instance)).toEqual({
    diagnostics: [],
    valid: true,
  });
});

test("invalid descriptor blocks only its presentation", () => {
  const invalid = testPresentation({
    descriptor: testDescriptor({ id: "Люди" }),
  });
  const valid = testPresentation({
    descriptor: testDescriptor({ id: "agents", label: "Agents" }),
  });

  expect(
    readSystemCollectionPresentationRuntime(invalid).instance.state.phase,
  ).toBe("blocking_error");
  expect(
    readSystemCollectionPresentationRuntime(invalid).diagnostics[0]?.code,
  ).toBe("invalid-presentation-id");
  expect(
    readSystemCollectionPresentationRuntime(valid).instance.state.phase,
  ).toBe("ready");
});

test("duplicate row identity becomes a blocking developer diagnostic", () => {
  const presentation = testPresentation({
    state: {
      phase: "ready",
      rows: [
        { id: "person:one", name: "One" },
        { id: "person:one", name: "Duplicate" },
      ],
    },
  });
  const runtime = readSystemCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("duplicate-row-id");
  expect(runtime.diagnostics[0]?.message.includes("person:one")).toBe(true);
});

test("invalid runtime row ids become a blocking diagnostic", () => {
  const getRowId = (() =>
    Promise.resolve(
      "person:one",
    )) as unknown as SystemCollectionPresentationDescriptor<TestRow>["getRowId"];
  const presentation = testPresentation({
    descriptor: testDescriptor({ getRowId }),
  });
  const runtime = readSystemCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("invalid-row-id");
});

test("opaque composite row ids are not constrained to descriptor id syntax", () => {
  const presentation = testPresentation({
    state: {
      phase: "ready",
      rows: [{ id: "пространство/Команда::ilya@example.com", name: "Ilya" }],
    },
  });

  expect(
    readSystemCollectionPresentationRuntime(presentation).instance.state.phase,
  ).toBe("ready");
});

test("property adapters require property value semantics", () => {
  const field: SystemCollectionFieldDescriptor<TestRow> = {
    filter: { kind: "property" },
    getValue: (row) => row.name,
    key: "name",
    label: "Name",
    valueSemantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const presentation = testPresentation({
    descriptor: testDescriptor({ fields: [field] }),
  });
  const runtime = readSystemCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("invalid-property-adapter");
});

test("standard field editing requires property value semantics", () => {
  const field: SystemCollectionFieldDescriptor<TestRow> = {
    edit: {
      getState: () => ({ status: "idle" }),
      update: async () => undefined,
    },
    getValue: (row) => row.name,
    key: "name",
    label: "Name",
    valueSemantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const presentation = testPresentation({
    descriptor: testDescriptor({ fields: [field] }),
  });
  const runtime = readSystemCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("invalid-property-adapter");
});

test("stable field and action ids and unique descriptor keys are validated", () => {
  const field: SystemCollectionFieldDescriptor<TestRow> = {
    getValue: (row) => row.name,
    key: "Имя",
    label: "Name",
  };
  const presentation = testPresentation({
    descriptor: testDescriptor({
      fields: [field, field],
      rowActions: [
        {
          getState: () => ({ status: "idle" }),
          id: "Открыть",
          label: "Open",
          run: () => undefined,
        },
        {
          getState: () => ({ status: "idle" }),
          id: "Открыть",
          label: "Open duplicate",
          run: () => undefined,
        },
      ],
    }),
  });

  expect(
    readSystemCollectionPresentationRuntime(presentation).diagnostics.map(
      ({ code }) => code,
    ),
  ).toEqual([
    "invalid-field-key",
    "invalid-field-key",
    "duplicate-field-key",
    "invalid-action-id",
    "invalid-action-id",
    "duplicate-action-id",
  ]);
});

test("field getters must return a synchronous normalized value", () => {
  const field: SystemCollectionFieldDescriptor<TestRow> = {
    getValue: () => Promise.resolve("async"),
    key: "name",
    label: "Name",
  };
  const presentation = testPresentation({
    descriptor: testDescriptor({ fields: [field] }),
  });

  expect(
    readSystemCollectionPresentationRuntime(presentation).diagnostics[0]?.code,
  ).toBe("async-field-value");
});

test("defaultSort and defaultCompare are mutually exclusive", () => {
  const field: SystemCollectionFieldDescriptor<TestRow> = {
    getValue: (row) => row.name,
    key: "name",
    label: "Name",
    sort: {
      kind: "custom",
      compare: (left, right) => left.name.localeCompare(right.name),
    },
    valueSemantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const presentation = testPresentation({
    descriptor: testDescriptor({
      fields: [field],
      query: {
        defaultCompare: (left, right) => left.name.localeCompare(right.name),
        defaultSort: [{ direction: "asc", fieldKey: "name" }],
      },
    }),
  });

  expect(
    readSystemCollectionPresentationRuntime(presentation).diagnostics[0]?.code,
  ).toBe("invalid-default-sort");
});

test("instance validation rejects missing defaults and duplicate presentation ids", () => {
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "missing",
    instanceKey: "space:root:actors",
    presentations: [testPresentation(), testPresentation()],
    stateScope: "session",
  };
  const result = validateSystemCollectionInstance(instance);

  expect(result.valid).toBe(false);
  expect(result.diagnostics.map(({ code }) => code)).toEqual([
    "duplicate-presentation-id",
    "invalid-default-presentation",
  ]);
});

test("active presentation falls back from saved to default to first available", () => {
  const people = testPresentation();
  const skills = testPresentation({
    descriptor: testDescriptor({ id: "skills", label: "Skills" }),
  });
  const instance: SystemCollectionInstance = {
    defaultPresentationId: "people",
    instanceKey: "space:root:context",
    presentations: [people, skills],
    stateScope: "session",
  };

  expect(resolveSystemCollectionPresentationId(instance, "skills")).toBe(
    "skills",
  );
  expect(resolveSystemCollectionPresentationId(instance, "stale")).toBe(
    "people",
  );
  expect(
    resolveSystemCollectionPresentationId(
      { ...instance, defaultPresentationId: "stale" },
      null,
    ),
  ).toBe("people");
  expect(
    resolveSystemCollectionPresentationId(
      { ...instance, presentations: [] },
      null,
    ),
  ).toBeNull();
});

test("instance registry rejects concurrent duplicate keys and releases idempotently", () => {
  const registry = new SystemCollectionInstanceRegistry();
  const registration = registry.register("space:root:actors");

  let duplicateError = "";
  try {
    registry.register("space:root:actors");
  } catch (error) {
    duplicateError = error instanceof Error ? error.message : String(error);
  }
  expect(duplicateError).toBe(
    'System Collection instanceKey "space:root:actors" is already mounted.',
  );

  registration.release();
  registration.release();
  const remounted = registry.register("space:root:actors");
  remounted.release();
});
