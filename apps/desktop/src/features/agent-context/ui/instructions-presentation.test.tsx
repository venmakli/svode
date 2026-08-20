import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EMPTY_SYSTEM_COLLECTION_QUERY,
  SystemCollectionPresentationShell,
} from "@/features/collection/system";

import type { AgentContextInstructionRow } from "../model/types";
import { createAgentContextInstructionsPresentation } from "./instructions-presentation";

const selected: AgentContextInstructionRow = {
  adapterId: "codex",
  body: "# Project instructions\n\n[Blocked link](https://example.com)",
  canonicalPath: "/workspace/AGENTS.md",
  discoveryPath: "/workspace/AGENTS.md",
  filename: "AGENTS.md",
  health: "normal",
  healthReasons: [],
  id: "codex:project:/workspace/AGENTS.md",
  linkTargetPath: null,
  ownerPath: "/workspace",
  precedence: 1,
  references: [],
  role: "codex_directory_precedence",
  scope: "project",
  support: "client_native",
  resolution: "selected",
  truncated: false,
};

test("instructions use the common coverless Gallery and safe reader detail", () => {
  let detailRowId: string | null = null;
  const presentation = createAgentContextInstructionsPresentation({
    onDetailRequested: (rowId) => {
      detailRowId = rowId;
    },
    state: { phase: "ready", rows: [selected] },
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
  expect(html.includes("repeat(auto-fill, minmax(240px, 1fr))")).toBe(true);
  expect(html.includes("max-width")).toBe(false);
  expect(html.includes('data-size="sm"')).toBe(true);
  expect(html.includes("group/gallery-cover")).toBe(false);
  expect(html.includes("Selected")).toBe(true);

  const descriptor = presentation as unknown as {
    instance: {
      descriptor: {
        createDetailRequest(row: AgentContextInstructionRow): {
          content: React.ReactNode;
        };
        layout: {
          cardSize: string;
          density: string;
        };
      };
    };
  };
  expect(descriptor.instance.descriptor.layout.cardSize).toBe("medium");
  expect(descriptor.instance.descriptor.layout.density).toBe("compact");
  expect("refresh" in descriptor.instance.descriptor).toBe(false);
  expect(html.includes("data-system-collection-refresh")).toBe(false);
  const detail = descriptor.instance.descriptor.createDetailRequest(selected);
  const detailHtml = renderToStaticMarkup(detail.content);
  expect(detailRowId as string | null).toBe(selected.id);
  expect(detailHtml.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(detailHtml.includes('href="https://example.com"')).toBe(false);
  expect(detailHtml.includes("Selected")).toBe(true);
});

test("superseded aliases keep neutral link provenance without a warning", () => {
  const presentation = createAgentContextInstructionsPresentation({
    state: {
      phase: "ready",
      rows: [
        {
          ...selected,
          discoveryPath: "/workspace/AGENTS.md",
          id: "codex:superseded:/workspace/AGENTS.md",
          linkTargetPath: "/workspace/shared/AGENTS.md",
          resolution: "superseded",
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
  expect(html.includes("Superseded")).toBe(true);
  expect(html.includes("AGENTS.override.md wins")).toBe(false);
  expect(html.includes("The source preview is degraded")).toBe(false);
  expect(html.includes("Codex project guidance")).toBe(false);
});

test("only row-local degraded health renders a warning overlay", () => {
  const degraded: AgentContextInstructionRow = {
    ...selected,
    health: "degraded",
    healthReasons: ["Preview was limited to 32 KiB"],
    truncated: true,
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <SystemCollectionPresentationShell
        instanceKey="agent-context:space:degraded"
        presentation={createAgentContextInstructionsPresentation({
          state: { phase: "ready", rows: [degraded] },
        })}
        query={EMPTY_SYSTEM_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Preview was limited to 32 KiB")).toBe(true);
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
    state: { phase: "ready", rows: [selected] },
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
  await action.run(selected);
  expect(action.id).toBe("open-in-vscode");
  expect(opened).toEqual([
    {
      canonicalArtifactPath: "/workspace/AGENTS.md",
      ownerRoot: "/workspace",
      tool: "vscode",
    },
  ]);
});
