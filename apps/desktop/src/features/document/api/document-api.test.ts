import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { invokeCommand } from "@/platform/native/invoke";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { DocumentSourceDescriptor } from "../model/types";

import {
  documentExternalOpenTarget,
  loadDocumentBytes,
  loadDocumentDescriptor,
  subscribeDocumentInvalidated,
} from "./document-api";

test("a document outside the Space reads and opens through its owner", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new JSDOM("", { url: "http://localhost/" }).window,
  });
  const steps: string[] = [];
  mockNativeIpc((command, args) => {
    steps.push(`${command}:${JSON.stringify(args)}`);
    if (command === "agent_context_inspect_skill_document") {
      return {
        format: "pdf",
        generation: "g1",
        modifiedAt: "2026-10-15T08:00:00Z",
        sizeBytes: 4,
      };
    }
    if (command === "agent_context_read_skill_document") {
      return new Uint8Array([37, 80, 68, 70]);
    }
    return null;
  });
  const path = "/home/user/.claude/skills/review/assets/guide.pdf";
  const input = { itemId: "skill:review", path: "assets/guide.pdf" };
  const target = {
    inspect: () =>
      invokeCommand<DocumentSourceDescriptor>(
        "agent_context_inspect_skill_document",
        input,
      ),
    read: async (expectedGeneration: string) =>
      new Uint8Array(
        await invokeCommand<Uint8Array>("agent_context_read_skill_document", {
          ...input,
          expectedGeneration,
        }),
      ),
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
    `agent_context_inspect_skill_document:{"itemId":"skill:review","path":"assets/guide.pdf"}`,
    `agent_context_read_skill_document:{"itemId":"skill:review","path":"assets/guide.pdf","expectedGeneration":"g1"}`,
    "attempt",
    "owner-open:null",
  ]);
  clearNativeMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});
