import { expect, spyOn, test } from "bun:test";
import * as bunTest from "bun:test";
import { toast } from "sonner";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CollectionSchema, Column } from "../model/types";

interface PendingRequest {
  columnName: string;
  resolve: (schema: CollectionSchema) => void;
  reject: (error: unknown) => void;
}

const requests: PendingRequest[] = [];
const mock = bunTest.mock;

mock.module("../api/schema-api", () => ({
  normalizeUniqueIdCounter: async () => ({ columns: [] }),
  updateSchemaColumn: (input: { columnName: string }) =>
    new Promise<CollectionSchema>((resolve, reject) => {
      requests.push({ columnName: input.columnName, resolve, reject });
    }),
}));

const { useColumnTypeSettings } = await import("./use-column-type-settings");

test("type settings ignore stale navigation responses and surface current errors", async () => {
  requests.length = 0;
  // A spy, not a module mock: a module mock of sonner stays for every later
  // test file of the process.
  const toastError = spyOn(toast, "error").mockReturnValue(0);
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const schemas: CollectionSchema[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    await act(async () => {
      root.render(
        <Harness
          column={{ name: "Done", type: "boolean" }}
          collectionPath="tasks-a"
          onSchemaChange={(schema) => schemas.push(schema)}
        />,
      );
    });

    await act(async () => {
      dom.window.document.querySelector("button")!.click();
    });
    expect(requests[0]?.columnName).toBe("Done");

    await act(async () => {
      root.render(
        <Harness
          column={{ name: "Published", type: "boolean" }}
          collectionPath="tasks-b"
          onSchemaChange={(schema) => schemas.push(schema)}
        />,
      );
    });
    await act(async () => {
      requests[0]!.resolve({
        columns: [{ name: "Done", type: "boolean", display: "switch" }],
      });
      await Promise.resolve();
    });
    expect(schemas).toEqual([]);

    await act(async () => {
      dom.window.document.querySelector("button")!.click();
    });
    expect(requests[1]?.columnName).toBe("Published");
    expect(dom.window.document.querySelector("button")!.dataset.pending).toBe(
      "true",
    );

    await act(async () => {
      requests[1]!.reject(new Error("save failed"));
      await Promise.resolve();
    });
    expect(schemas).toEqual([]);
    expect(toastError.mock.calls.length).toBe(1);
    expect(dom.window.document.querySelector("button")!.dataset.pending).toBe(
      "false",
    );
  } finally {
    toastError.mockRestore();
    console.error = originalConsoleError;
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function Harness({
  column,
  collectionPath,
  onSchemaChange,
}: {
  column: Column;
  collectionPath: string;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  const { patchColumn, pending } = useColumnTypeSettings({
    column,
    collectionPath,
    onSchemaChange,
    spacePath: "/project",
  });

  return (
    <button
      type="button"
      data-pending={String(pending)}
      onClick={() => void patchColumn({ display: "switch" })}
    >
      Save
    </button>
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
