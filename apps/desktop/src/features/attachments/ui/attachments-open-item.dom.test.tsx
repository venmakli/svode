import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { AttachmentsSnapshotDto } from "@/platform/attachments/attachments-api";
import { createTestDom } from "@/shared/testing/dom";
import type { AttachmentItem } from "../model/types";

function folder(path: string): AttachmentItem {
  return {
    key: `directory:${path}`,
    path,
    contentPath: null,
    ownerPath: path,
    sourcePath: path,
    sourceShape: "directory",
    kind: "directory",
    hasApp: false,
    hasChildren: true,
    icon: null,
    displayName: path.split("/").at(-1)!,
    modified: "",
    sizeBytes: null,
    format: "",
    availability: "available",
  };
}

const TITLE =
  "a request to open a folder opens its peek once over the owner's Attachments";

if (process.env.SVODE_ATTACHMENTS_OPEN_ITEM_TEST !== "1") {
  test(
    TITLE,
    () => {
      const child = spawnSync(
        process.execPath,
        ["test", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, SVODE_ATTACHMENTS_OPEN_ITEM_TEST: "1" },
          encoding: "utf8",
        },
      );
      if (child.status !== 0) throw new Error(child.stdout + child.stderr);
      expect(child.status).toBe(0);
    },
    30_000,
  );
} else {
  const { mock } = bunTest;
  // The Page session of the owner stands outside this surface.
  mock.module("@/features/page/scope-surface", () => ({
    PageDetailProvider: ({ children }: { children: ReactNode }) => children,
    PageSurfaceSessionProvider: ({ children }: { children: ReactNode }) =>
      children,
    usePageDetailContext: () => null,
    useOptionalPageDetailContext: () => null,
    ReadmeSurface: () => null,
    usePageSurfaceSession: () => ({
      runMutation: async (operation: () => Promise<void>) => operation(),
    }),
  }));
  test(
    TITLE,
    async () => {
      const dom = await createTestDom();
      const branchReads: string[] = [];
      mockNativeIpc(
        (command, args) => {
          if (command !== "attachments_list") return 1;
          const branchPath =
            args && "branchPath" in args ? (args.branchPath as string) : null;
          if (branchPath) branchReads.push(branchPath);
          const snapshot: AttachmentsSnapshotDto = {
            owner: {
              projectPath: "/repo",
              spacePath: "/repo",
              spaceId: null,
              ownerPath: ".",
              repositoryPath: "/repo",
            },
            generation: branchPath ?? "root",
            items:
              branchPath === "reports"
                ? [folder("reports/q3")]
                : branchPath
                  ? []
                  : [folder("reports")],
            diagnostics: [],
          };
          return snapshot;
        },
        { shouldMockEvents: true },
      );
      const { TooltipProvider } = await import("@/components/ui/tooltip");
      const { ScopeSurfaceHost, useScopeSurfaceStore } =
        await import("@/features/scope-surfaces");
      const { AttachmentsSurface } = await import("./attachments-surface");
      const { attachmentOwnerFromScopeOwner } = await import("../model/types");
      type Host = Parameters<typeof ScopeSurfaceHost>[0];
      const owner: Host["owner"] = {
        ownerKey: "space:root",
        identityKind: "registered-space",
        spaceId: "root",
        spacePath: "/repo",
        projectPath: "/repo",
        ownerPath: ".",
        readmePath: "README.md",
        capabilities: ["space"],
      };
      const contributions: Host["contributions"] = [
        {
          id: "readme",
          order: 0,
          presentations: ["full"],
          appliesTo: () => true,
          label: "README",
          icon: () => null,
          render: () => <div data-readme />,
        },
        {
          id: "attachments",
          order: 1,
          presentations: ["full"],
          appliesTo: () => true,
          label: "Attachments",
          icon: () => null,
          render: ({ owner, openItem }) => (
            <AttachmentsSurface
              owner={attachmentOwnerFromScopeOwner(owner)}
              readOnly={false}
              renderOwnerPeek={() => null}
              openItem={openItem}
            />
          ),
        },
      ];
      const render = (key: number, itemId: string) =>
        dom.render(
          <TooltipProvider>
            <ScopeSurfaceHost
              owner={owner}
              presentation="full"
              contributions={contributions}
              header={null}
              sessionKey={key}
              openRequestKey={key}
              openIntent={{ kind: "target", surfaceId: "attachments", itemId }}
            />
          </TooltipProvider>,
        );
      const settle = () =>
        act(async () => {
          for (let index = 0; index < 10; index += 1)
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
      const dialog = () => dom.document.querySelector('[role="dialog"]');
      const peekName = () =>
        dialog()?.querySelector("[data-peek-identity] [title]")?.textContent;
      const showTab = (surfaceId: "readme" | "attachments") =>
        act(async () =>
          useScopeSurfaceStore.getState().setSurface(owner.ownerKey, surfaceId),
        );

      try {
        // A nested folder: its ancestors are read one by one.
        await render(1, "reports/q3");
        await settle();
        expect(branchReads).toEqual(["reports", "reports/q3"]);
        expect(peekName()).toBe("q3");

        // Closing the peek leaves the Attachments.
        await act(async () =>
          dialog()!.querySelector<HTMLElement>('[aria-label="Close"]')!.click(),
        );
        await settle();
        expect(dialog()).toBeNull();
        expect(
          Boolean(dom.document.querySelector("[data-attachments-surface]")),
        ).toBe(true);

        // Showing the tab again does not repeat the request.
        await showTab("readme");
        expect(dom.document.querySelector("[data-attachments-surface]")).toBe(
          null,
        );
        await showTab("attachments");
        await settle();
        expect(
          Boolean(dom.document.querySelector("[data-attachments-surface]")),
        ).toBe(true);
        expect(dialog()).toBeNull();

        // A folder that is gone: the Attachments without a peek or an error.
        await render(2, "archive");
        await settle();
        expect(dialog()).toBeNull();
        expect(dom.document.querySelector('[role="alert"]')).toBeNull();
        expect(
          useScopeSurfaceStore.getState().openItemRequestKeyByOwnerKey[
            owner.ownerKey
          ],
        ).toBe(2);

        await render(3, "reports");
        await settle();
        expect(peekName()).toBe("reports");
      } finally {
        await dom.render(null);
        await settle();
        clearNativeMocks();
        await dom.dispose();
      }
    },
    30_000,
  );
}
