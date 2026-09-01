import { expect, test } from "bun:test";

import type { CollectionPropertyDefinition } from "@/features/properties";
import type {
  CollectionInstance,
  CollectionPresentationDescriptor,
  CollectionPresentationInstance,
} from "./types";
import {
  CollectionInstanceRegistry,
  resolveCollectionPresentationId,
  validateCollectionInstance,
} from "./instance-runtime";
import {
  defineCollectionPresentation,
  readCollectionPresentationRuntime,
} from "./runtime";

interface TestRow {
  id: string;
  name: string;
}

function customProperty(
  overrides: Partial<CollectionPropertyDefinition<TestRow>> = {},
): CollectionPropertyDefinition<TestRow> {
  return {
    getValue: (row) => row.name,
    key: "name",
    label: "Name",
    origin: "domain_specific",
    owner: { featureId: "test", kind: "feature" },
    semantics: { kind: "custom", render: (value) => String(value) },
    ...overrides,
  };
}

function testDescriptor(
  overrides: Partial<CollectionPresentationDescriptor<TestRow>> = {},
): CollectionPresentationDescriptor<TestRow> {
  return {
    properties: [],
    getRowId: (row) => row.id,
    id: "people",
    label: "People",
    layout: {
      getTitle: (row) => row.name,
      kind: "list",
      visibleProperties: [],
    },
    query: {},
    ...overrides,
  };
}

function testPresentation(
  overrides: Partial<CollectionPresentationInstance<TestRow>> = {},
) {
  return defineCollectionPresentation<TestRow>({
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
  const skills = defineCollectionPresentation<SkillRow>({
    descriptor: {
      properties: [],
      getRowId: (row) => row.path,
      id: "skills",
      label: "Skills",
      layout: {
        cardSize: "large",
        density: "comfortable",
        getTitle: (row) => row.path,
        kind: "gallery",
        visibleProperties: [],
      },
      query: {},
    },
    state: {
      phase: "ready",
      rows: [{ path: "skills/review/SKILL.md" }],
    },
  });
  const instance: CollectionInstance = {
    defaultPresentationId: "people",
    instanceKey: "space:root:actors",
    presentations: [people, skills],
    stateScope: "session",
  };

  expect(validateCollectionInstance(instance)).toEqual({
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

  expect(readCollectionPresentationRuntime(invalid).instance.state.phase).toBe(
    "blocking_error",
  );
  expect(readCollectionPresentationRuntime(invalid).diagnostics[0]?.code).toBe(
    "invalid-presentation-id",
  );
  expect(readCollectionPresentationRuntime(valid).instance.state.phase).toBe(
    "ready",
  );
});

test("runtime validation rejects unsupported and malformed Gallery layouts", () => {
  const unsupported = testPresentation({
    descriptor: testDescriptor({
      layout: {
        kind: "board",
        visibleProperties: [],
      } as unknown as CollectionPresentationDescriptor<TestRow>["layout"],
    }),
  });
  const malformedGallery = testPresentation({
    descriptor: testDescriptor({
      layout: {
        cardSize: "wide",
        density: "dense",
        getTitle: (row: TestRow) => row.name,
        kind: "gallery",
        visibleProperties: ["missing", "missing"],
      } as unknown as CollectionPresentationDescriptor<TestRow>["layout"],
    }),
  });

  expect(
    readCollectionPresentationRuntime(unsupported).diagnostics.map(
      ({ code }) => code,
    ),
  ).toEqual(["invalid-layout"]);
  expect(
    readCollectionPresentationRuntime(malformedGallery).diagnostics.map(
      ({ code }) => code,
    ),
  ).toEqual([
    "invalid-gallery-card-size",
    "invalid-gallery-density",
    "unknown-visible-property",
    "unknown-visible-property",
    "duplicate-visible-property",
  ]);
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
  const runtime = readCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("duplicate-row-id");
  expect(runtime.diagnostics[0]?.message.includes("person:one")).toBe(true);
});

test("invalid runtime row ids become a blocking diagnostic", () => {
  const getRowId = (() =>
    Promise.resolve(
      "person:one",
    )) as unknown as CollectionPresentationDescriptor<TestRow>["getRowId"];
  const presentation = testPresentation({
    descriptor: testDescriptor({ getRowId }),
  });
  const runtime = readCollectionPresentationRuntime(presentation);

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
    readCollectionPresentationRuntime(presentation).instance.state.phase,
  ).toBe("ready");
});

test("standard property capabilities require standard value semantics", () => {
  const property = customProperty({
    capabilities: { filter: { kind: "standard" } },
  });
  const presentation = testPresentation({
    descriptor: testDescriptor({ properties: [property] }),
  });
  const runtime = readCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("invalid-property-capability");
});

test("standard property editing requires standard value semantics", () => {
  const property = customProperty({
    capabilities: {
      edit: {
        getState: () => ({ status: "idle" }),
        update: async () => undefined,
      },
    },
  });
  const presentation = testPresentation({
    descriptor: testDescriptor({ properties: [property] }),
  });
  const runtime = readCollectionPresentationRuntime(presentation);

  expect(runtime.instance.state.phase).toBe("blocking_error");
  expect(runtime.diagnostics[0]?.code).toBe("invalid-property-capability");
});

test("property origins enforce schema and computed ownership boundaries", () => {
  const schemaBacked = customProperty({
    origin: "schema_backed",
    owner: { column: { name: "name", type: "text" }, kind: "schema" },
  });
  const computed = customProperty({
    capabilities: {
      edit: {
        getState: () => ({ status: "idle" }),
        update: () => undefined,
      },
    },
    key: "score",
    origin: "computed",
  });
  const runtime = readCollectionPresentationRuntime(
    testPresentation({
      descriptor: testDescriptor({ properties: [schemaBacked, computed] }),
    }),
  );

  expect(runtime.diagnostics.map(({ code }) => code)).toEqual([
    "invalid-property-origin",
    "invalid-property-origin",
    "invalid-property-capability",
  ]);
});

test("stable property and action ids and unique descriptor keys are validated", () => {
  const property = customProperty({
    key: "Имя",
  });
  const presentation = testPresentation({
    descriptor: testDescriptor({
      properties: [property, property],
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
    readCollectionPresentationRuntime(presentation).diagnostics.map(
      ({ code }) => code,
    ),
  ).toEqual([
    "invalid-property-key",
    "invalid-property-key",
    "duplicate-property-key",
    "invalid-action-id",
    "invalid-action-id",
    "duplicate-action-id",
  ]);
});

test("create and row actions share one stable id namespace", () => {
  const presentation = testPresentation({
    descriptor: testDescriptor({
      create: {
        label: "Create",
        intents: [
          {
            getState: () => ({ status: "idle" }),
            id: "mutate",
            label: "Create",
            run: () => undefined,
          },
        ],
      },
      rowActions: [
        {
          getState: () => ({ status: "idle" }),
          id: "mutate",
          label: "Edit",
          run: () => undefined,
        },
      ],
    }),
  });

  expect(
    readCollectionPresentationRuntime(presentation).diagnostics.map(
      ({ code }) => code,
    ),
  ).toEqual(["duplicate-action-id"]);
});

test("property getters must return a synchronous normalized value", () => {
  const property = customProperty({
    getValue: () => Promise.resolve("async"),
  });
  const presentation = testPresentation({
    descriptor: testDescriptor({ properties: [property] }),
  });

  expect(
    readCollectionPresentationRuntime(presentation).diagnostics[0]?.code,
  ).toBe("async-property-value");
});

test("defaultSort and defaultCompare are mutually exclusive", () => {
  const property = customProperty({
    capabilities: {
      sort: {
        kind: "custom",
        compare: (left, right) => left.name.localeCompare(right.name),
      },
    },
  });
  const presentation = testPresentation({
    descriptor: testDescriptor({
      properties: [property],
      query: {
        defaultCompare: (left, right) => left.name.localeCompare(right.name),
        defaultSort: [{ direction: "asc", propertyKey: "name" }],
      },
    }),
  });

  expect(
    readCollectionPresentationRuntime(presentation).diagnostics[0]?.code,
  ).toBe("invalid-default-sort");
});

test("instance validation rejects missing defaults and duplicate presentation ids", () => {
  const instance: CollectionInstance = {
    defaultPresentationId: "missing",
    instanceKey: "space:root:actors",
    presentations: [testPresentation(), testPresentation()],
    stateScope: "session",
  };
  const result = validateCollectionInstance(instance);

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
  const instance: CollectionInstance = {
    defaultPresentationId: "people",
    instanceKey: "space:root:context",
    presentations: [people, skills],
    stateScope: "session",
  };

  expect(resolveCollectionPresentationId(instance, "skills")).toBe("skills");
  expect(resolveCollectionPresentationId(instance, "stale")).toBe("people");
  expect(
    resolveCollectionPresentationId(
      { ...instance, defaultPresentationId: "stale" },
      null,
    ),
  ).toBe("people");
  expect(
    resolveCollectionPresentationId({ ...instance, presentations: [] }, null),
  ).toBeNull();
});

test("instance registry reports concurrent keys and recovers after release", () => {
  const registry = new CollectionInstanceRegistry();
  const counts: number[] = [];
  const unsubscribe = registry.subscribe(() => {
    counts.push(registry.getCount("space:root:actors"));
  });
  const first = registry.register("space:root:actors");
  const second = registry.register("space:root:actors");

  expect(registry.getCount("space:root:actors")).toBe(2);
  second.release();
  expect(registry.getCount("space:root:actors")).toBe(1);
  second.release();
  first.release();
  expect(registry.getCount("space:root:actors")).toBe(0);
  expect(counts).toEqual([1, 2, 1, 0]);
  unsubscribe();
});
