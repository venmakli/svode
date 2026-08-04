import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationShell,
} from "@/features/collection/system";

import type { AgentContextInstructionRow } from "../model/types";
import { createAgentContextInstructionsPresentation } from "./instructions-presentation";

const available: AgentContextInstructionRow = {
  adapterId: "codex",
  availability: "available",
  availabilityReason: "Selected by Codex precedence",
  body: "# Project instructions\n\n[Blocked link](https://example.com)",
  canonicalPath: "/workspace/AGENTS.md",
  diagnostics: [],
  discoveryPath: "/workspace/AGENTS.md",
  filename: "AGENTS.md",
  id: "codex:project:/workspace/AGENTS.md",
  linkTargetPath: null,
  ownerPath: "/workspace",
  precedence: 1,
  references: [],
  role: "codex_directory_precedence",
  scope: "project",
  truncated: false,
};

test("instructions use the common coverless Gallery and safe reader detail", () => {
  let detailRowId: string | null = null;
  const presentation = createAgentContextInstructionsPresentation({
    onDetailRequested: (rowId) => {
      detailRowId = rowId;
    },
    onRefresh: () => undefined,
    refreshing: false,
    state: { phase: "ready", rows: [available] },
  });
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationShell
        instanceKey="agent-context:space:root"
        presentation={presentation}
        query={EMPTY_SYSTEM_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(
    html.includes(
      'data-system-collection-row="codex:project:/workspace/AGENTS.md"',
    ),
  ).toBe(true);
  expect(html.includes("AGENTS.md")).toBe(true);
  expect(html.includes("group/gallery-cover")).toBe(false);

  const descriptor = presentation as unknown as {
    instance: {
      descriptor: {
        createDetailRequest(row: AgentContextInstructionRow): {
          content: React.ReactNode;
        };
      };
    };
  };
  const detail = descriptor.instance.descriptor.createDetailRequest(available);
  const detailHtml = renderToStaticMarkup(detail.content);
  expect(detailRowId as string | null).toBe(available.id);
  expect(detailHtml.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(detailHtml.includes('href="https://example.com"')).toBe(false);
});

test("shadowed aliases expose link and warning overlays without a subtitle", () => {
  const presentation = createAgentContextInstructionsPresentation({
    onRefresh: () => undefined,
    refreshing: false,
    state: {
      phase: "ready",
      rows: [
        {
          ...available,
          availability: "shadowed",
          availabilityReason: "AGENTS.override.md wins in this directory",
          discoveryPath: "/workspace/AGENTS.md",
          id: "codex:shadowed:/workspace/AGENTS.md",
          linkTargetPath: "/workspace/shared/AGENTS.md",
        },
      ],
    },
  });
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationShell
        instanceKey="agent-context:space:root"
        presentation={presentation}
        query={EMPTY_SYSTEM_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Filesystem alias")).toBe(true);
  expect(html.includes("AGENTS.override.md wins")).toBe(true);
  expect(html.includes("Codex project guidance")).toBe(false);
});

test("instruction external action keeps the canonical artifact and owner together", async () => {
  const opened: unknown[] = [];
  const presentation = createAgentContextInstructionsPresentation({
    artifactOpeners: [
      {
        capabilities: ["open_workspace_file"],
        id: "vscode",
        kind: "editor",
        label: "VS Code",
      },
    ],
    onOpenArtifact: (input) => {
      opened.push(input);
    },
    onRefresh: () => undefined,
    refreshing: false,
    state: { phase: "ready", rows: [available] },
  }) as unknown as {
    instance: {
      descriptor: {
        rowActions: Array<{
          id: string;
          run(row: AgentContextInstructionRow): void;
        }>;
      };
    };
  };

  const action = presentation.instance.descriptor.rowActions[0]!;
  await action.run(available);
  expect(action.id).toBe("open-in-vscode");
  expect(opened).toEqual([
    {
      canonicalArtifactPath: "/workspace/AGENTS.md",
      ownerRoot: "/workspace",
      tool: "vscode",
    },
  ]);
});
