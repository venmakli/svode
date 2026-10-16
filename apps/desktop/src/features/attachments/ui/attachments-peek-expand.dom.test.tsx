import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";
import type { AttachmentActivationRequest } from "../model/types";

if (process.env.SVODE_ATTACHMENTS_PEEK_EXPAND_TEST !== "1") {
  test("Expand of a document or media peek opens the same file in main", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ATTACHMENTS_PEEK_EXPAND_TEST: "1" },
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
  // The viewers stand in for the real ones and expose their Expand.
  const viewer =
    (kind: string) =>
    ({ onOpenFullPage }: { onOpenFullPage: () => void }) => (
      <button data-expand={kind} onClick={onOpenFullPage}>
        Expand
      </button>
    );
  mock.module("@/features/document/app-shell", () => ({
    DocumentSurface: viewer("document"),
  }));
  mock.module("@/features/media/app-shell", () => ({
    MediaSurface: viewer("media"),
  }));
  const dom = await createTestDom();
  const project = "/project";
  mockNativeIpc(
    (command) => {
      if (command === "git_status")
        return {
          branch: "main",
          ahead: 0,
          behind: 0,
          hasStaged: false,
          hasUnstaged: false,
          hasConflicts: false,
          tracking: null,
          files: [],
        };
      if (command === "repository_access_get")
        return {
          status: "local",
          repositoryId: project,
          generation: 1,
          checkedAt: null,
          expiresAt: null,
          lastKnownStatus: null,
          reason: null,
        };
      throw new Error(`Unexpected IPC: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { AttachmentsPeek } = await import("./attachments-peek");
  const { closeActiveContent, getActiveContentSelection, openScopeOwner } =
    await import("@/features/artifact");

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 5; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function expand(
    kind: "document" | "media",
    path: string,
    owner: { spaceId: string | null; spacePath: string },
  ) {
    const target: AttachmentActivationRequest = {
      row: {
        key: `${kind}:${path}`,
        path,
        contentPath: null,
        ownerPath: ".",
        sourcePath: path,
        sourceShape: "file",
        kind,
        hasApp: false,
        icon: null,
        displayName: path,
        modified: "",
        sizeBytes: null,
        format: "",
        availability: "available",
      },
      owner: {
        projectPath: project,
        spacePath: owner.spacePath,
        spaceId: owner.spaceId,
        ownerPath: ".",
        repositoryPath: owner.spacePath,
      },
      mode: "peek",
      sourceGeneration: "one",
      activation: { rowId: `${kind}:${path}` },
    };
    const openChanges: boolean[] = [];
    await dom.render(
      <TooltipProvider>
        <AttachmentsPeek
          owner={{
            ownerKey: `space:${owner.spaceId ?? "root"}`,
            identityKind: "registered-space",
            projectPath: project,
            spacePath: owner.spacePath,
            spaceId: owner.spaceId ?? "root",
            ownerPath: ".",
            contentPath: "README.md",
            hasDirectCollection: false,
          }}
          readOnly={false}
          target={target}
          onOpenChange={(open) => openChanges.push(open)}
          renderOwnerPeek={() => null}
        />
      </TooltipProvider>,
    );
    await settle();
    await act(async () =>
      dom.document.querySelector<HTMLElement>(`[data-expand=${kind}]`)!.click(),
    );
    await dom.render(null);
    return openChanges;
  }

  test("Expand from the attachments of the project root opens the file in the root Space", async () => {
    for (const [kind, path] of [
      ["document", "notes.docx"],
      ["document", "report.pdf"],
      ["media", "photo.png"],
      ["media", "video.mp4"],
    ] as const) {
      // The home page of the project root is open behind the Peek; the
      // backend reports the root owner without a Space id.
      openScopeOwner({ kind: "space", spaceId: "root" });
      const openChanges = await expand(kind, path, {
        spaceId: null,
        spacePath: project,
      });
      expect(openChanges).toEqual([false]);
      const selection = getActiveContentSelection().selection;
      expect(
        selection?.kind === "artifact" ? selection.request.intent.target : null,
      ).toEqual({ spaceId: "root", path, sourceShape: "file" });
    }
    closeActiveContent();
  });

  test("Expand from the attachments of a registered Space opens the file in that Space", async () => {
    openScopeOwner({ kind: "space", spaceId: "root" });
    const openChanges = await expand("document", "brief.pdf", {
      spaceId: "team",
      spacePath: `${project}/team`,
    });
    expect(openChanges).toEqual([false]);
    const selection = getActiveContentSelection().selection;
    expect(
      selection?.kind === "artifact" ? selection.request.intent.target : null,
    ).toEqual({ spaceId: "team", path: "brief.pdf", sourceShape: "file" });
    closeActiveContent();
    clearNativeMocks();
    await dom.dispose();
  });
}
