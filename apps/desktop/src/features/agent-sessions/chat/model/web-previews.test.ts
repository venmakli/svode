import { expect, test } from "bun:test";
import type {
  AgentActivityItemDto,
  AgentToolLocationDto,
  AgentTurnStateDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { turnChanges } from "./changed-files";
import { projectTimeline } from "./timeline";
import { webPreviewCandidates, webPreviewFiles } from "./web-previews";

const idle: AgentTurnStateDto = {
  turnId: "t1",
  phase: "none",
  lastOutcome: "end_turn",
  status: {
    state: "idle",
    stopReason: "end_turn",
    source: "svode_runtime",
    confidence: "exact",
  },
};

function edit(
  id: string,
  locations: AgentToolLocationDto[],
  tool = "edit",
): AgentActivityItemDto {
  return {
    id,
    turnId: "t1",
    kind: "tool_call",
    tool,
    media: [],
    locations,
    mcpCalls: [],
    status: "completed",
    summary: id,
    hasDetail: true,
  } as AgentActivityItemDto;
}

const at = (
  path: string,
  change: AgentToolLocationDto["change"],
): AgentToolLocationDto => ({ path, change, lines: null });

function changesOf(items: AgentActivityItemDto[]) {
  const [turn] = projectTimeline({
    turn: idle,
    items: [
      ...items,
      {
        id: "m1",
        turnId: "t1",
        kind: "agent_message",
        media: [],
        status: null,
        summary: "Done",
        hasDetail: false,
      },
    ],
  });
  return turnChanges(turn);
}

const project = [{ id: "root", path: "/p" }];

const paths = (files: { path: string }[]) => files.map((file) => file.path);

test("the HTML files a turn changed, without deleted ones and hidden folders", () => {
  const changes = changesOf([
    edit("a", [at("/p/report.html", "created")]),
    edit("b", [at("/p/notes.md", "modified")]),
    edit("c", [at("/tmp/scratch/.codex_scratch/x.html", "created")]),
    edit("d", [at("/p/old.html", "deleted")], "delete"),
    edit("e", [at("/p/moved/page.HTM", "moved")], "move"),
    // A repeated path counts once, at its first appearance.
    edit("f", [at("/p/report.html", "modified")]),
    edit("g", [at("/p/.hidden.html", "created")]),
    edit("h", [at("/p/unknown.html", null)]),
  ]);
  const candidates = webPreviewCandidates(changes, project);
  expect(paths(webPreviewFiles(candidates, new Set()))).toEqual([
    "/p/report.html",
    "/p/moved/page.HTM",
    "/p/.hidden.html",
  ]);
  expect(paths(candidates)).toEqual([
    "/p/report.html",
    "/p/moved/page.HTM",
    "/p/.hidden.html",
    "/p/unknown.html",
  ]);
});

test("files of an App are left out and four files give three cards", () => {
  const changes = changesOf([
    edit("a", [at("/p/one.html", "created")]),
    edit("b", [at("/p/tools/dash/index.html", "modified")]),
    edit("c", [at("/p/two.html", "created")]),
    edit("d", [at("/p/three.html", "created")]),
    edit("e", [at("/p/four.html", "created")]),
  ]);
  expect(
    paths(
      webPreviewFiles(
        webPreviewCandidates(changes, project),
        new Set(["/p/tools/dash/index.html"]),
      ),
    ),
  ).toEqual(["/p/one.html", "/p/two.html", "/p/three.html"]);
  expect(webPreviewCandidates(null, project)).toEqual([]);
});

test("a file of the project is judged by its path in its Space", () => {
  const spaces = [{ id: "root", path: "/home/u/.worktrees/p" }];
  const changes = changesOf([
    edit("a", [at("/home/u/.worktrees/p/report.html", "created")]),
    edit("b", [at("/home/u/.worktrees/p/.svode/x.html", "created")]),
    edit("c", [at("/home/u/.cache/out.html", "created")]),
  ]);
  expect(paths(webPreviewCandidates(changes, spaces))).toEqual([
    "/home/u/.worktrees/p/report.html",
  ]);
});
