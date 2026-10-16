import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";

import { createTestDom } from "@/shared/testing/dom";

import type { DocumentTarget } from "../model/types";

if (process.env.SVODE_DOCUMENT_SESSION_DOM !== "1") {
  test("document session checks the generation on invalidation", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DOCUMENT_SESSION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };

  interface Deferred {
    resolve(): void;
    reject(error: unknown): void;
  }

  const checks: Array<Deferred & { generation: string }> = [];
  const listeners = new Set<() => void>();
  let reads = 0;
  let descriptorGate: Promise<void> | null = null;

  mock.module("../api/document-api", () => ({
    checkDocumentSource: (_target: DocumentTarget, generation: string) =>
      new Promise<void>((resolve, reject) => {
        checks.push({ generation, reject, resolve });
      }),
    documentExternalOpenTarget: () => ({
      listApps: async () => [],
      open: async () => undefined,
      preferenceKey: "pdf",
    }),
    loadDocumentBytes: async () => {
      reads += 1;
      return new Uint8Array([1]);
    },
    loadDocumentDescriptor: async () => {
      await descriptorGate;
      return {
        format: "pdf",
        generation: "g1",
        modifiedAt: "2026-01-02T03:04:05Z",
        sizeBytes: 1,
      };
    },
    subscribeDocumentInvalidated: async (
      _target: DocumentTarget,
      handler: () => void,
    ) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  }));
  class PdfRuntimeFailure extends Error {
    kind = "renderer_error";
  }
  mock.module("../pdf/pdf-runtime", () => ({
    isAbortError: () => false,
    openPdfDocument: async () => ({ numPages: 3 }),
    PdfRuntimeFailure,
  }));
  mock.module("../pdf/pdf-text-index", () => ({
    extractPdfText: async () => undefined,
  }));

  const { useDocumentSession } = await import("./use-document-session");
  const { documentSessionCoordinator } = await import("../model/session");
  type Session = ReturnType<typeof useDocumentSession>;

  const dom = await createTestDom();
  let session: Session | null = null;

  function Harness({ target }: { target: DocumentTarget }) {
    const latest = useDocumentSession(target);
    useEffect(() => {
      session = latest;
    });
    return null;
  }

  function current() {
    return session!;
  }

  function failureKind() {
    const { state } = current();
    return state.phase === "failed" ? state.failure.kind : null;
  }

  async function settle() {
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  function invalidate() {
    for (const listener of listeners) listener();
  }

  function target(path = "docs/report.pdf"): DocumentTarget {
    return {
      path,
      projectPath: "/work/project",
      spaceId: null,
      spacePath: "/work/project",
    };
  }

  async function open(documentTarget = target()) {
    documentSessionCoordinator.resetForTests();
    checks.length = 0;
    reads = 0;
    await dom.render(<Harness target={documentTarget} />);
    await settle();
  }

  const changed = { kind: "source_changed" };

  test("an unchanged generation keeps the ready document and its view", async () => {
    await open();
    expect(current().state.phase).toBe("ready");
    const ready = current().state;
    await act(async () => {
      current().updateViewState((view) => ({
        ...view,
        findQuery: "total",
        pageNumber: 3,
        zoom: 1.5,
      }));
    });

    invalidate();
    await settle();
    expect(checks.map((check) => check.generation).join()).toBe("g1");
    checks[0]!.resolve();
    await settle();

    expect(current().state === ready).toBe(true);
    expect(reads).toBe(1);
    expect(current().viewState.pageNumber).toBe(3);
    expect(current().viewState.zoom).toBe(1.5);
    expect(current().viewState.findQuery).toBe("total");
    expect(current().source?.generation).toBe("g1");
  });

  test("a changed generation and a missing file end the session", async () => {
    await open();
    invalidate();
    await settle();
    checks[0]!.reject(changed);
    await settle();
    expect(failureKind()).toBe("source_changed");
    expect(current().source).toBeNull();

    // A failed session no longer checks.
    invalidate();
    await settle();
    expect(checks.length).toBe(1);

    await open(target("docs/other.pdf"));
    invalidate();
    await settle();
    checks[0]!.reject({ kind: "source_missing" });
    await settle();
    expect(failureKind()).toBe("source_missing");
  });

  test("an event before the generation is known does not fail the load", async () => {
    let release = () => {};
    descriptorGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await open(target("docs/early.pdf"));
      expect(current().state.phase).toBe("loading");
      invalidate();
      await settle();
      expect(checks.length).toBe(0);
      release();
      await settle();
      expect(current().state.phase).toBe("ready");
      expect(checks.length).toBe(0);
    } finally {
      descriptorGate = null;
    }
  });

  test("a check result after Retry or another target is dropped", async () => {
    await open(target("docs/retry.pdf"));
    invalidate();
    await settle();
    await act(async () => current().retry());
    await settle();
    expect(current().state.phase).toBe("ready");
    checks[0]!.reject(changed);
    await settle();
    expect(current().state.phase).toBe("ready");

    invalidate();
    await settle();
    expect(checks.length).toBe(2);
    await dom.render(<Harness target={target("docs/next.pdf")} />);
    await settle();
    checks[1]!.reject(changed);
    await settle();
    expect(current().state.phase).toBe("ready");
  });

  test("events during a check are checked after it", async () => {
    await open(target("docs/twice.pdf"));
    invalidate();
    await settle();
    invalidate();
    await settle();
    expect(checks.length).toBe(1);
    checks[0]!.resolve();
    await settle();
    expect(checks.length).toBe(2);
    checks[1]!.resolve();
    await settle();
    expect(current().state.phase).toBe("ready");

    // The file changes between the two events: the later check decides.
    invalidate();
    await settle();
    invalidate();
    await settle();
    checks[2]!.resolve();
    await settle();
    expect(current().state.phase).toBe("ready");
    checks[3]!.reject(changed);
    await settle();
    expect(failureKind()).toBe("source_changed");
    expect(reads).toBe(1);

    await dom.dispose();
  });
}
