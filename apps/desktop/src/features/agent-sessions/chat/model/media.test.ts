import { expect, test } from "bun:test";
import type {
  AgentActivityItemDto,
  AgentMediaSegmentDto,
  AgentTurnStateDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { shownEntries } from "./expansion";
import {
  agentMessageParts,
  createsMedia,
  groupMedia,
  mediaFileName,
  tileLayout,
  turnCreatedMediaCount,
  chatMediaOf,
} from "./media";
import { projectTimeline } from "./timeline";

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

function segment(
  id: string,
  overrides: Partial<AgentMediaSegmentDto> = {},
): AgentMediaSegmentDto {
  return {
    id,
    kind: "image",
    name: null,
    mimeType: "image/png",
    path: `/tmp/${id}.png`,
    size: 10,
    hasData: false,
    offset: null,
    ...overrides,
  };
}

function tool(
  id: string,
  tool: string,
  media: AgentMediaSegmentDto[] = [],
): AgentActivityItemDto {
  return {
    id,
    turnId: "t1",
    kind: "tool_call",
    tool,
    media,
    locations: [],
    mcpCalls: [],
    status: "completed",
    summary: id,
    hasDetail: false,
  } as AgentActivityItemDto;
}

function message(id: string, summary: string): AgentActivityItemDto {
  return {
    id,
    turnId: "t1",
    kind: "agent_message",
    media: [],
    status: null,
    summary,
    hasDetail: false,
  };
}

const user = {
  id: "user:t1",
  turnId: "t1",
  kind: "user_message",
  segments: [],
  status: null,
  summary: "Draw",
  hasDetail: false,
} as AgentActivityItemDto;

const outcome = {
  id: "outcome:t1",
  turnId: "t1",
  kind: "turn_outcome",
  reason: "end_turn",
  durationMs: 9000,
  status: null,
  summary: "",
  hasDetail: false,
} as AgentActivityItemDto;

test("a tool call creates media unless it only read or searched", () => {
  const generation = tool("gen", "other", [segment("a")]);
  expect(createsMedia(generation as never)).toBe(true);
  expect(createsMedia(tool("read", "read", [segment("b")]) as never)).toBe(
    false,
  );
  expect(createsMedia(tool("find", "search", [segment("c")]) as never)).toBe(
    false,
  );
  expect(createsMedia(tool("run", "execute") as never)).toBe(false);
});

test("a folded turn keeps the rows of created media outside, each on its own, and counts only folded items", () => {
  const [turn] = projectTimeline({
    turn: idle,
    items: [
      user,
      tool("run", "execute"),
      tool("gen1", "other", [segment("a"), segment("b")]),
      tool("view", "read", [segment("c")]),
      tool("find", "search", [segment("d")]),
      tool("gen2", "execute", [segment("e")]),
      message("m1", "Here"),
      outcome,
    ],
  });
  expect(turn.summary?.count).toBe(3);
  expect([...(turn.summary?.mediaRowIds ?? [])]).toEqual(["gen1", "gen2"]);
  const shown = shownEntries({}, turn);
  expect(
    shown.map((entry) =>
      entry.kind === "tools"
        ? `tools:${entry.rows.map((row) => row.item.id).join(",")}`
        : entry.id,
    ),
  ).toEqual(["user:t1", "tools:gen1", "tools:gen2", "m1"]);
  // Unfolded, created media stay on their own rows; the rest group as before.
  const unfolded = shownEntries({ "summary:t1": true }, turn);
  expect(
    unfolded
      .filter((entry) => entry.kind === "tools")
      .map((entry) => entry.rows.map((row) => row.item.id).join(",")),
  ).toEqual(["run", "gen1", "view,find", "gen2"]);
  expect(turnCreatedMediaCount(turn)).toBe(3);
});

test("a turn whose only tool calls created media has no summary row and shows each on its own", () => {
  const [turn] = projectTimeline({
    turn: idle,
    items: [
      user,
      tool("gen1", "other", [segment("a")]),
      tool("gen2", "other", [segment("b")]),
      message("m1", "Two"),
      outcome,
    ],
  });
  expect(turn.summary).toBe(null);
  expect(
    shownEntries({}, turn).map((entry) =>
      entry.kind === "tools" ? entry.rows.length : 0,
    ),
  ).toEqual([0, 1, 1, 0]);

  const [single] = projectTimeline({
    turn: idle,
    items: [
      user,
      tool("gen1", "other", [segment("a")]),
      message("m1", "One"),
      outcome,
    ],
  });
  expect(single.summary).toBe(null);
});

test("tiles lay out by their count, five and more as 2×2 with +N opening the rest", () => {
  expect(tileLayout(1, false)).toEqual({ kind: "single", shown: 1, more: 0 });
  expect(tileLayout(2, false)).toEqual({ kind: "pair", shown: 2, more: 0 });
  expect(tileLayout(3, false)).toEqual({ kind: "triple", shown: 3, more: 0 });
  expect(tileLayout(4, false)).toEqual({ kind: "grid", shown: 4, more: 0 });
  expect(tileLayout(7, false)).toEqual({ kind: "grid", shown: 4, more: 4 });
  expect(tileLayout(7, true)).toEqual({ kind: "grid", shown: 7, more: 0 });
});

test("an agent message places its media at their offsets in the text", () => {
  const text = "Before\n\nMiddle\n\nAfter";
  const parts = agentMessageParts("m1", text, [
    segment("0", { offset: 8 }),
    segment("1", { offset: 8, kind: "audio", path: "/tmp/a.wav" }),
    segment("2", { offset: 16 }),
    segment("3", { offset: null, kind: "file", path: "/tmp/r.pdf" }),
  ]);
  expect(
    parts.map((part) =>
      part.type === "text"
        ? part.text
        : part.media.map((media) => media.key).join(","),
    ),
  ).toEqual(["Before\n\n", "m1:0,m1:1", "Middle\n\n", "m1:2", "After", "m1:3"]);
  const groups = groupMedia(
    (parts[1] as { media: ReturnType<typeof chatMediaOf>[] }).media,
  );
  expect(groups.tiles.length).toBe(1);
  expect(groups.audio.length).toBe(1);
  // Out of range offsets stay in the text's bounds.
  expect(
    agentMessageParts("m1", "Hi", [segment("0", { offset: 99 })]).map(
      (part) => part.type,
    ),
  ).toEqual(["text", "media"]);
});

test("media without a file get a file name by their MIME type", () => {
  const data = chatMediaOf(
    "i",
    segment("0", { path: null, hasData: true, name: null }),
  );
  expect(data.data).toEqual({ itemId: "i", segmentId: "0" });
  expect(mediaFileName(data, "image/jpeg")).toBe("image.jpg");
  expect(mediaFileName({ ...data, name: "shot.png" }, "image/png")).toBe(
    "shot.png",
  );
});
