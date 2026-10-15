import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import {
  documentExternalOpenTarget,
  loadDocumentBytes,
  loadDocumentDescriptor,
  subscribeDocumentInvalidated,
} from "./document-api";

test("a local document reads by its absolute path and opens through its owner's target", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new JSDOM("", { url: "http://localhost/" }).window,
  });
  const steps: string[] = [];
  mockNativeIpc((command, args) => {
    steps.push(`${command}:${JSON.stringify(args)}`);
    if (command === "document_inspect_local_source") {
      return {
        format: "pdf",
        generation: "g1",
        modifiedAt: "2026-10-15T08:00:00Z",
        sizeBytes: 4,
      };
    }
    if (command === "document_read_local_source") {
      return new Uint8Array([37, 80, 68, 70]);
    }
    return null;
  });
  const path = "/home/user/.claude/skills/review/assets/guide.pdf";
  const target = {
    externalOpen: {
      listApps: async () => [],
      open: async (appId: string | null) => {
        steps.push(`owner-open:${appId}`);
      },
      preferenceKey: "file:pdf",
    },
    kind: "local" as const,
    path,
  };

  const descriptor = await loadDocumentDescriptor(target);
  const bytes = await loadDocumentBytes(target, descriptor.generation);
  const unlisten = await subscribeDocumentInvalidated(target, () => undefined);
  unlisten();
  const open = documentExternalOpenTarget(target, () => steps.push("attempt"));
  await open.open(null);

  expect(descriptor.format).toBe("pdf");
  expect([...bytes]).toEqual([37, 80, 68, 70]);
  expect(open.reveal).toBe(undefined);
  expect(steps).toEqual([
    `document_inspect_local_source:{"path":"${path}"}`,
    `document_read_local_source:{"expectedGeneration":"g1","path":"${path}"}`,
    "attempt",
    "owner-open:null",
  ]);
  clearNativeMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});
