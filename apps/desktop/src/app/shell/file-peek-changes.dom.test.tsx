import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useContext, useEffect, type ReactNode } from "react";
import type { AttachmentActivationRequest } from "@/features/attachments";
import type { SpaceInfo } from "@/features/space";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_FILE_PEEK_CHANGES_TEST !== "1") {
  test("document and media peeks show the Changes of their one file", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_FILE_PEEK_CHANGES_TEST: "1" },
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
  // The viewers stand in for the real ones: they place the Changes they get
  // into their peek top bar.
  const viewer =
    (kind: string) =>
    ({ path, changes }: { path: string; changes?: ReactNode }) => (
      <div data-viewer={kind} data-path={path}>
        {changes}
      </div>
    );
  mock.module("@/features/document/app-shell", () => ({
    DocumentSurface: viewer("document"),
  }));
  mock.module("@/features/media/app-shell", () => ({
    MediaSurface: viewer("media"),
  }));
  const dom = await createTestDom();
  const doc = dom.document;
  const project = "/project";
  mockNativeIpc(
    (command) => {
      if (command === "git_status")
        return {
          branch: "main",
          ahead: 0,
          behind: 0,
          hasStaged: false,
          hasUnstaged: true,
          hasConflicts: false,
          tracking: null,
          files: ["docs/report.pdf", "docs/photo.png", "docs/notes.md"].map(
            (path) => ({ path, state: "modified" }),
          ),
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
  const { AttachmentsPeek } = await import("@/features/attachments");
  const { ChatAttachmentOpenerContext } =
    await import("@/features/agent-sessions");
  const { registerRootSpace } = await import("@/features/space");
  const { ChatAttachmentPeekProvider } = await import("./chat-attachment-peek");

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 5; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  function changesOf(kind: string) {
    return doc.querySelector<HTMLButtonElement>(
      `[data-viewer=${kind}] [data-changes-trigger]`,
    );
  }

  test("Attachments: a document and a media row show the Changes of that file", async () => {
    for (const [kind, path] of [
      ["document", "docs/report.pdf"],
      ["media", "docs/photo.png"],
    ] as const) {
      const target: AttachmentActivationRequest = {
        row: {
          key: `${kind}:${path}`,
          path,
          contentPath: null,
          ownerPath: "docs",
          sourcePath: path,
          sourceShape: "file",
          kind,
          hasApp: false,
          icon: null,
          displayName: path.split("/").at(-1)!,
          modified: "",
          sizeBytes: null,
          format: "",
          availability: "available",
        },
        owner: {
          projectPath: project,
          spacePath: project,
          spaceId: null,
          ownerPath: ".",
          repositoryPath: project,
        },
        mode: "peek",
        sourceGeneration: "one",
        activation: { rowId: `${kind}:${path}` },
      };
      await dom.render(
        <TooltipProvider>
          <AttachmentsPeek
            owner={{
              ownerKey: "space:root",
              identityKind: "registered-space",
              projectPath: project,
              spacePath: project,
              spaceId: "root",
              ownerPath: ".",
              contentPath: "README.md",
              hasDirectCollection: false,
            }}
            readOnly={false}
            target={target}
            onOpenChange={() => {}}
            renderOwnerPeek={() => null}
          />
        </TooltipProvider>,
      );
      await settle();
      const changes = changesOf(kind)!;
      // One changed file of the three in the repository: this one.
      expect(changes.textContent).toBe("1");
      expect(
        changes.getAttribute("aria-label")?.includes(path.split("/").at(-1)!),
      ).toBe(true);
      await dom.render(null);
    }
  });

  test("chat attachment: a document and a media file show the Changes of that file", async () => {
    registerRootSpace({
      id: "root",
      name: "Project",
      path: project,
    } as SpaceInfo);
    let open: ((attachment: { path: string; name: string }) => void) | null =
      null;
    function Opener() {
      const opener = useContext(ChatAttachmentOpenerContext);
      useEffect(() => {
        open = opener;
      });
      return null;
    }
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    for (const [kind, name] of [
      ["document", "report.pdf"],
      ["media", "photo.png"],
    ] as const) {
      await act(async () => open!({ path: `${project}/docs/${name}`, name }));
      await settle();
      const changes = changesOf(kind)!;
      expect(changes.textContent).toBe("1");
      expect(changes.getAttribute("aria-label")?.includes(name)).toBe(true);
    }
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  });
}
