import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Dispatch, SetStateAction } from "react";

import type { CollectionSchema } from "@/features/properties";

interface PendingRequest {
  collectionPath: string;
  resolve: (schema: CollectionSchema) => void;
}

const requests: PendingRequest[] = [];
const mock = (
  bunTest as unknown as {
    mock: { module: (specifier: string, factory: () => unknown) => void };
  }
).mock;

mock.module("../api", () => ({
  getCollectionSchema: (input: { collectionPath: string }) =>
    new Promise<CollectionSchema>((resolve) => {
      requests.push({ collectionPath: input.collectionPath, resolve });
    }),
}));

const { useCollectionSchemaState } =
  await import("./use-collection-schema-state");

test("collection schema state rejects late loads and setters from a previous target", async () => {
  requests.length = 0;
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  let staleSetter:
    | Dispatch<SetStateAction<CollectionSchema | null>>
    | undefined;

  try {
    await act(async () => {
      root.render(
        <Harness
          collectionPath="tasks-a"
          captureSetter={(setter) => {
            staleSetter = setter;
          }}
        />,
      );
    });
    expect(requests[0]?.collectionPath).toBe("tasks-a");

    await act(async () => {
      root.render(<Harness collectionPath="tasks-b" />);
    });
    expect(requests[1]?.collectionPath).toBe("tasks-b");

    await act(async () => {
      requests[1]!.resolve({
        columns: [{ name: "Published", type: "boolean", display: "switch" }],
      });
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent?.includes("Published")).toBe(
      true,
    );

    await act(async () => {
      requests[0]!.resolve({
        columns: [{ name: "Done", type: "boolean", display: "checkbox" }],
      });
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent?.includes("Published")).toBe(
      true,
    );
    expect(dom.window.document.body.textContent?.includes("Done")).toBe(false);

    await act(async () => {
      staleSetter?.({
        columns: [{ name: "Archived", type: "boolean" }],
      });
    });
    expect(dom.window.document.body.textContent?.includes("Published")).toBe(
      true,
    );
    expect(dom.window.document.body.textContent?.includes("Archived")).toBe(
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("collection path handoff keeps the loaded schema visible during refresh", async () => {
  requests.length = 0;
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<Harness collectionPath="tasks" />);
    });
    await act(async () => {
      requests[0]!.resolve({
        columns: [{ name: "Status", type: "status" }],
      });
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent?.includes("Status")).toBe(
      true,
    );

    await act(async () => {
      root.render(
        <Harness collectionPath="Задачи" previousCollectionPath="tasks" />,
      );
    });
    expect(requests[1]?.collectionPath).toBe("Задачи");
    expect(dom.window.document.body.textContent?.includes("Status")).toBe(
      true,
    );
    expect(dom.window.document.body.textContent?.includes("loading")).toBe(
      false,
    );

    await act(async () => {
      requests[1]!.resolve({
        columns: [{ name: "Status", type: "status" }],
      });
      await Promise.resolve();
    });
    expect(dom.window.document.body.textContent?.includes("Status")).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function Harness({
  collectionPath,
  previousCollectionPath,
  captureSetter,
}: {
  collectionPath: string;
  previousCollectionPath?: string | null;
  captureSetter?: (
    setter: Dispatch<SetStateAction<CollectionSchema | null>>,
  ) => void;
}) {
  const { schema, setSchema, loading } = useCollectionSchemaState({
    collectionPath,
    previousCollectionPath,
    spacePath: "/project",
  });
  captureSetter?.(setSchema);

  return (
    <div>{loading ? "loading" : (schema?.columns[0]?.name ?? "empty")}</div>
  );
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
