import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import type { AttachmentBranch } from "../model/source-session";
import type {
  AttachmentItem,
  AttachmentsSnapshot,
  ResolvedAttachmentOwner,
} from "../model/types";
import type { AttachmentsSource } from "./attachment-hierarchy";

// The warning above the list of a folder peek in Attachments: present only
// for a diagnostic of the branch, with its text in one frame.
if (process.env.SVODE_DIRECTORY_PEEK_TABLE_DOM !== "1") {
  test("Directory peek table DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DIRECTORY_PEEK_TABLE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const path = "reports";
  const folder: AttachmentItem = {
    availability: "available",
    contentPath: null,
    displayName: "reports",
    format: "directory",
    hasApp: false,
    icon: null,
    key: "directory:reports",
    kind: "directory",
    modified: "2026-11-06",
    ownerPath: path,
    path,
    sizeBytes: null,
    sourcePath: path,
    sourceShape: "directory",
  };
  const report: AttachmentItem = {
    ...folder,
    contentPath: "reports/q3.pdf",
    displayName: "q3",
    format: "pdf",
    key: "document:reports/q3.pdf",
    kind: "document",
    ownerPath: null,
    path: "reports/q3.pdf",
    sizeBytes: 1024,
    sourcePath: "reports/q3.pdf",
    sourceShape: "file",
  };

  function snapshot(
    items: AttachmentItem[],
    diagnostics: AttachmentsSnapshot["diagnostics"] = [],
  ): AttachmentsSnapshot {
    return {
      owner: {} as ResolvedAttachmentOwner,
      generation: "1",
      items,
      diagnostics,
    };
  }

  function branch(patch: Partial<AttachmentBranch>): AttachmentBranch {
    return {
      target: folder,
      loading: false,
      error: null,
      request: 1,
      snapshot: snapshot([report]),
      ...patch,
    };
  }

  let ownerIndex = 0;
  const retries: string[] = [];

  async function renderPeek(state: AttachmentBranch) {
    const { setLocale } = await import("@/paraglide/runtime");
    await setLocale("en", { reload: false });
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { DirectoryPeekTable } = await import("./directory-peek-table");
    const source = {
      branches: new Map([[path, state]]),
      expanded: new Set<string>(),
      loadBranch: async (branchPath: string) => {
        retries.push(branchPath);
      },
      observeBranch: () => undefined,
      toggle: () => undefined,
    } as unknown as AttachmentsSource;
    const ownerKey = `owner-${ownerIndex++}`;
    await dom.render(
      <TooltipProvider>
        <DirectoryPeekTable
          key={ownerKey}
          path={path}
          ownerKey={ownerKey}
          source={source}
          origin={{ itemId: folder.key }}
          onActivate={() => undefined}
        />
      </TooltipProvider>,
    );
  }

  const { createTestDom } = await import("@/shared/testing/dom");
  const dom = await createTestDom();
  const plaques = () => [
    ...dom.document.querySelectorAll<HTMLElement>(
      "[data-collection-diagnostics]",
    ),
  ];
  const rows = () => dom.document.querySelectorAll("[data-collection-row]");

  test("a listed folder without a diagnostic has no warning", async () => {
    await renderPeek(branch({}));
    expect(rows().length).toBe(1);
    expect(plaques().length).toBe(0);
  });

  test("a refresh of the listed folder keeps the list without a warning", async () => {
    await renderPeek(branch({ loading: true }));
    expect(rows().length).toBe(1);
    expect(plaques().length).toBe(0);
  });

  test("a partly read folder shows each diagnostic in one frame", async () => {
    await renderPeek(
      branch({
        snapshot: snapshot(
          [report],
          [
            { code: "unreadable", path: "reports/locked" },
            { code: "unreadable", path: "reports/hidden" },
          ],
        ),
      }),
    );
    expect(rows().length).toBe(1);
    const [plaque, ...rest] = plaques();
    expect(rest.length).toBe(0);
    expect(
      plaque!.textContent.includes(
        "Could not inspect reports/locked; the remaining attachments are still available.",
      ),
    ).toBe(true);
    expect(
      plaque!.textContent.includes("Could not inspect reports/hidden"),
    ).toBe(true);
    expect(plaque!.querySelectorAll('[data-slot="alert"]').length).toBe(0);
  });

  test("a failed refresh of the listed folder shows its text and Retry", async () => {
    const { buttonByText, clickElement } =
      await import("@/shared/testing/dom-query");
    await renderPeek(branch({ error: "Disk is gone" }));
    expect(rows().length).toBe(1);
    const [plaque, ...rest] = plaques();
    expect(rest.length).toBe(0);
    expect(plaque!.textContent.includes("Disk is gone")).toBe(true);
    expect(plaque!.querySelectorAll('[data-slot="alert"]').length).toBe(0);
    retries.length = 0;
    await clickElement(buttonByText(plaque!, "Retry"));
    expect(retries).toEqual([path]);
  });

  test("an empty folder shows its empty state without a warning", async () => {
    await renderPeek(branch({ snapshot: snapshot([]) }));
    expect(rows().length).toBe(0);
    expect(plaques().length).toBe(0);
    expect(dom.document.body.textContent.includes("No available items")).toBe(
      true,
    );
  });

  test("a failed first load shows the blocking error with Retry", async () => {
    const { buttonByText, clickElement } =
      await import("@/shared/testing/dom-query");
    await renderPeek(branch({ snapshot: undefined, error: "No access" }));
    const blocking = dom.document.querySelector<HTMLElement>(
      "[data-collection-blocking-error]",
    );
    expect(blocking?.textContent.includes("No access")).toBe(true);
    expect(plaques().length).toBe(0);
    retries.length = 0;
    await clickElement(buttonByText(blocking!, "Retry"));
    expect(retries).toEqual([path]);
  });

  test("dispose the DOM", async () => {
    await dom.dispose();
  });
}
