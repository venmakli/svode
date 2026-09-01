import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EMPTY_COLLECTION_QUERY,
  CollectionPresentationShell,
} from "@/features/collection";

import type { AgentContextInstructionRow } from "../model/types";
import {
  createAgentContextInstructionsPresentation,
  createInstructionDetailContent,
} from "./instructions-presentation";

const selected: AgentContextInstructionRow = {
  adapterId: "codex",
  body: "# Project instructions\n\n[Blocked link](https://example.com)",
  canonicalPath: "/workspace/AGENTS.md",
  discoveryPath: "/workspace/AGENTS.md",
  filename: "AGENTS.md",
  health: "normal",
  healthReasons: [],
  id: "codex:project:/workspace/AGENTS.md",
  linkKind: "direct",
  linkTargetPath: null,
  location: "space",
  ownerPath: "/workspace",
  precedence: 1,
  references: [],
  role: "codex_directory_precedence",
  support: "client_native",
  resolution: "selected",
  truncated: false,
};

test("instructions use the common coverless Gallery and safe reader detail", () => {
  const presentation = createAgentContextInstructionsPresentation({
    state: { phase: "ready", rows: [selected] },
  });
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:root"
        presentation={presentation}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(
    html.includes('data-collection-row="codex:project:/workspace/AGENTS.md"'),
  ).toBe(true);
  expect(html.includes("AGENTS.md")).toBe(true);
  expect(html.includes("repeat(auto-fill, minmax(240px, 1fr))")).toBe(true);
  expect(html.includes("max-width")).toBe(false);
  expect(html.includes('data-size="sm"')).toBe(true);
  expect(html.includes("group/gallery-cover")).toBe(false);
  expect(html.includes("Selected")).toBe(false);
  expect(html.includes("Codex")).toBe(false);
  expect(html.includes("Project")).toBe(false);
  expect(html.includes("Personal")).toBe(false);

  const descriptor = presentation as unknown as {
    instance: {
      descriptor: {
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
  expect(html.includes("data-collection-refresh")).toBe(false);
  const detail = createInstructionDetailContent(selected);
  const detailHtml = renderToStaticMarkup(detail.content);
  const detailTitleHtml = renderToStaticMarkup(detail.title);
  expect(detailTitleHtml.includes("lucide-file-text")).toBe(true);
  expect(detailTitleHtml.includes("AGENTS.md")).toBe(true);
  expect(renderToStaticMarkup(detail.description).includes("sr-only")).toBe(
    true,
  );
  expect(detailHtml.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(detailHtml.includes('href="https://example.com"')).toBe(false);
  expect(detailHtml.includes("Source and location")).toBe(true);
  expect(detailHtml.includes('aria-expanded="false"')).toBe(true);
  expect(detailHtml.includes("Canonical source")).toBe(false);
  expect(detailHtml.includes("Discovery sources")).toBe(false);
  expect(detailHtml.includes("Space")).toBe(true);
  expect(detailHtml.includes("Direct")).toBe(false);
});

test("superseded aliases keep neutral link provenance without a warning", () => {
  const linkedRow: AgentContextInstructionRow = {
    ...selected,
    discoveryPath: "/workspace/AGENTS.md",
    id: "codex:superseded:/workspace/AGENTS.md",
    linkKind: "directory_alias",
    linkTargetPath: "/workspace/shared/AGENTS.md",
    resolution: "superseded",
  };
  const presentation = createAgentContextInstructionsPresentation({
    state: {
      phase: "ready",
      rows: [linkedRow],
    },
  });
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:root"
        presentation={presentation}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Directory alias")).toBe(true);
  expect(html.includes("Superseded")).toBe(false);
  expect(html.includes("AGENTS.override.md wins")).toBe(false);
  expect(html.includes("The source preview is degraded")).toBe(false);
  expect(html.includes("Codex project guidance")).toBe(false);

  const detailHtml = renderToStaticMarkup(
    createInstructionDetailContent(linkedRow).content,
  );
  expect(detailHtml.includes("Superseded")).toBe(false);
  expect(detailHtml.includes("Directory alias")).toBe(true);
  expect(detailHtml.includes("Canonical source")).toBe(false);
});

test("instruction cards show only exceptional factual source metadata", () => {
  const global = {
    ...selected,
    canonicalPath: "/home/user/.codex/AGENTS.md",
    discoveryPath: "/home/user/.codex/AGENTS.md",
    id: "codex:global:/home/user/.codex/AGENTS.md",
    location: "global" as const,
    ownerPath: "/home/user/.codex",
    role: "codex_user_precedence" as const,
  };
  const recognized = {
    ...selected,
    adapterId: null,
    canonicalPath: "/workspace/SOUL.md",
    discoveryPath: "/workspace/SOUL.md",
    filename: "SOUL.md",
    id: "recognized:/workspace/SOUL.md",
    role: "target_root_recognition" as const,
    support: "svode_recognized" as const,
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CollectionPresentationShell
        instanceKey="agent-context:space:source-metadata"
        presentation={createAgentContextInstructionsPresentation({
          state: { phase: "ready", rows: [selected, global, recognized] },
        })}
        query={EMPTY_COLLECTION_QUERY}
        onQueryChange={() => undefined}
      />
    </TooltipProvider>,
  );

  expect(html.includes("Global")).toBe(true);
  expect(html.includes("Recognized by Svode")).toBe(true);
  expect(html.includes("Codex")).toBe(false);
  expect(html.includes("Project")).toBe(false);
  expect(html.includes("Personal")).toBe(false);
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
      <CollectionPresentationShell
        instanceKey="agent-context:space:degraded"
        presentation={createAgentContextInstructionsPresentation({
          state: { phase: "ready", rows: [degraded] },
        })}
        query={EMPTY_COLLECTION_QUERY}
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
