import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import type { CollectionCreateCapability } from "@/features/collection";

// The module mocks must not reach other test files of the process.
const isolated = process.env.SVODE_ATTACHMENTS_CREATE_TEST === "1";
if (!isolated) {
  test("attachments create intents", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ATTACHMENTS_CREATE_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
}
const isolatedTest = (isolated ? test : () => undefined) as typeof test;

let importResult: () => Promise<unknown> = async () => ({});
let refreshResult: () => Promise<void> = async () => undefined;
let refreshed = 0;

if (isolated) {
  const { mock } = bunTest;
  mock.module("../api/attachments-api", () => ({
    importAttachmentFile: () => importResult(),
    pickAttachmentImportSource: async () => "/Users/me/photo.png",
  }));
  mock.module("@/features/page/scope-surface", () => ({
    usePageSurfaceSession: () => ({
      runMutation: (operation: () => Promise<void>) => operation(),
    }),
  }));
  mock.module("@/features/page", () => ({
    publishPageFilenameWarnings: () => undefined,
  }));
  mock.module("@/features/page/page-api", () => ({
    createPage: async () => ({ path: "Untitled.md", warnings: [] }),
  }));
  mock.module("@/features/page/navigation", () => ({
    useOpenPage: () => () => undefined,
  }));
  mock.module("@/features/space", () => ({
    useSpaceTreeSync: (
      select: (state: { reloadTreePathParent(): Promise<void> }) => unknown,
    ) => select({ reloadTreePathParent: async () => undefined }),
  }));
}

async function importIntent() {
  const { useAttachmentsCreate } = await import("./use-attachments-create");
  let capability: CollectionCreateCapability | null = null;
  function Harness({
    onCapability,
  }: {
    onCapability(value: CollectionCreateCapability): void;
  }) {
    const value = useAttachmentsCreate({
      owner: {
        contentPath: "Plan/README.md",
        hasDirectCollection: false,
        identityKind: "page-directory",
        ownerKey: "plan",
        ownerPath: "Plan",
        projectPath: "/project",
        spaceId: "root",
        spacePath: "/project",
      },
      readOnly: false,
      refresh: async () => {
        refreshed += 1;
        await refreshResult();
      },
    });
    onCapability(value);
    return null;
  }
  renderToStaticMarkup(
    <Harness
      onCapability={(value) => {
        capability = value;
      }}
    />,
  );
  const intent = (
    capability as CollectionCreateCapability | null
  )?.intents.find((candidate) => candidate.id === "import-file");
  if (!intent) throw new Error("no import intent");
  return intent;
}

isolatedTest(
  "a refused import rejects with the text the create control shows",
  async () => {
    refreshed = 0;
    importResult = () =>
      Promise.reject({
        kind: "lfs_not_ready",
        reason: "s3_not_connected",
        code: "S3_NOT_CONNECTED",
        message:
          "Git LFS route is not ready: this device is not connected to the S3 storage of the project",
      });
    const intent = await importIntent();

    await expect(Promise.resolve(intent.run())).rejects.toThrow(
      "File not added: this device is not connected to the S3 storage of the project — choose S3 keys in Settings → Storage",
    );
    expect(refreshed).toBe(0);
  },
);

isolatedTest(
  "a refresh failure after the import is not reported as a file not added",
  async () => {
    refreshed = 0;
    importResult = async () => ({});
    refreshResult = () => Promise.reject(new Error("list failed"));
    const intent = await importIntent();

    await expect(Promise.resolve(intent.run())).rejects.toThrow("list failed");
    expect(refreshed).toBe(1);
    refreshResult = async () => undefined;
  },
);
