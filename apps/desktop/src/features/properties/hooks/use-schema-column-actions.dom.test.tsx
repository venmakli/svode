import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { CollectionSchema, Column } from "../model/types";

const isolatedProcess = process.env.SVODE_SCHEMA_ACTIONS_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("schema column actions DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SCHEMA_ACTIONS_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  interface PendingRequest {
    kind: "add" | "rename" | "type" | "delete";
    resolve: (schema: CollectionSchema) => void;
    reject: (error: unknown) => void;
  }

  const requests: PendingRequest[] = [];
  const toastErrors: unknown[] = [];
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;

  function pending(kind: PendingRequest["kind"]) {
    return new Promise<CollectionSchema>((resolve, reject) => {
      requests.push({ kind, resolve, reject });
    });
  }

  mock.module("../api/schema-api", () => ({
    addSchemaColumn: () => pending("add"),
    changeSchemaType: () =>
      pending("type").then((schema) => ({ schema, warnings: [] })),
    deleteSchemaColumn: () => pending("delete"),
    renameSchemaColumn: () => pending("rename"),
  }));
  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toastErrors.push(message),
      warning: () => undefined,
    },
  }));

  const { useSchemaColumnActions } =
    await import("./use-schema-column-actions");

  test("schema actions dedupe pending work and ignore late owners", async () => {
    requests.length = 0;
    toastErrors.length = 0;
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
      const render = async (
        column: Column,
        collectionPath: string,
        schema: CollectionSchema = { columns: [column] },
      ) => {
        await act(async () => {
          root.render(
            <Harness
              column={column}
              schema={schema}
              collectionPath={collectionPath}
              onSchemaChange={(schema) => schemas.push(schema)}
            />,
          );
        });
      };

      await render({ name: "Status", type: "text" }, "tasks-a");
      const duplicate = dom.window.document.querySelector<HTMLButtonElement>(
        "[data-action=duplicate]",
      )!;
      await act(async () => {
        duplicate.click();
        duplicate.click();
      });
      expect(requests.map((request) => request.kind)).toEqual(["add"]);

      await act(async () => {
        requests[0]!.resolve({
          columns: [
            { name: "Status", type: "text" },
            { name: "Status (copy)", type: "text" },
          ],
        });
        await Promise.resolve();
      });
      expect(schemas.length).toBe(1);

      dom.window.document
        .querySelector<HTMLButtonElement>("[data-action=rename]")!
        .click();
      expect(requests[1]?.kind).toBe("rename");

      await render({ name: "Priority", type: "number" }, "tasks-b");
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-action=rename]")!
        .click();
      expect(requests[2]?.kind).toBe("rename");

      await act(async () => {
        requests[1]!.resolve({ columns: [{ name: "Renamed", type: "text" }] });
        requests[2]!.reject(new Error("save failed"));
        await Promise.resolve();
      });
      expect(schemas.length).toBe(1);
      expect(toastErrors.length).toBe(1);

      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-action=rename]")!
          .click();
      });
      expect(requests[3]?.kind).toBe("rename");
      await render({ name: "Priority", type: "number" }, "tasks-b", {
        columns: [
          { name: "Priority", type: "number" },
          { name: "Context", type: "text" },
        ],
      });
      await act(async () => {
        requests[3]!.resolve({
          columns: [{ name: "Renamed", type: "number" }],
        });
        await Promise.resolve();
      });
      expect(schemas.length).toBe(1);

      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-action=rename]")!
          .click();
      });
      expect(requests[4]?.kind).toBe("rename");
      await act(async () => {
        requests[4]!.resolve({
          columns: [{ name: "Renamed", type: "number" }],
        });
        await Promise.resolve();
      });

      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-action=type]")!
          .click();
      });
      expect(requests[5]?.kind).toBe("type");
      await act(async () => {
        requests[5]!.resolve({
          columns: [{ name: "Priority", type: "text" }],
        });
        await Promise.resolve();
      });

      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>("[data-action=delete]")!
          .click();
      });
      expect(requests[6]?.kind).toBe("delete");
      await act(async () => {
        requests[6]!.resolve({ columns: [] });
        await Promise.resolve();
      });
      expect(schemas.length).toBe(4);
    } finally {
      console.error = originalConsoleError;
      await act(async () => root.unmount());
      restoreGlobals();
      dom.window.close();
    }
  });

  function Harness({
    column,
    schema,
    collectionPath,
    onSchemaChange,
  }: {
    column: Column;
    schema: CollectionSchema;
    collectionPath: string;
    onSchemaChange: (schema: CollectionSchema) => void;
  }) {
    const {
      changeColumnType,
      deleteColumn,
      duplicateColumn,
      pendingAction,
      renameColumn,
    } = useSchemaColumnActions({
      schema,
      column,
      collectionPath,
      spacePath: "/project",
      onSchemaChange,
    });
    return (
      <>
        <button
          type="button"
          data-action="duplicate"
          data-pending={String(pendingAction !== null)}
          onClick={() => void duplicateColumn()}
        >
          Duplicate
        </button>
        <button
          type="button"
          data-action="rename"
          onClick={() => void renameColumn("Renamed")}
        >
          Rename
        </button>
        <button
          type="button"
          data-action="type"
          onClick={() => void changeColumnType("text")}
        >
          Change type
        </button>
        <button
          type="button"
          data-action="delete"
          onClick={() => void deleteColumn(true)}
        >
          Delete
        </button>
      </>
    );
  }
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
