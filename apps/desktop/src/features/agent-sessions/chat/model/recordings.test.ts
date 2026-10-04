import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSessionDeltaDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { applyAgentActivityMessage } from "../../model/activity";
import { shownEntries } from "./expansion";
import { projectTimeline, type TimelineEntry } from "./timeline";

/**
 * Turns as the runtime delivered them, written by
 * `cargo run -p svode-agents --example live_turn -- --record <file>`: the
 * snapshot before the prompt, every delta, fresh runtime snapshots taken
 * along the way, and the final snapshot.
 */
interface Recording {
  agent: string;
  initial: AgentSessionSnapshotDto;
  deltas: AgentSessionDeltaDto[];
  checkpoints: AgentSessionSnapshotDto[];
  final: AgentSessionSnapshotDto;
}

const directory = fileURLToPath(new URL("./fixtures", import.meta.url));
const recordings = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    recording: JSON.parse(
      readFileSync(join(directory, name), "utf8"),
    ) as Recording,
  }));

function entryIds(entries: TimelineEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "tools" ? entry.rows.map((row) => row.item.id) : [entry.id],
  );
}

test("recordings are present", () => {
  expect(recordings.length > 0).toBe(true);
});

for (const { name, recording } of recordings) {
  test(`${name}: each prefix projects like the runtime snapshot at that seq`, () => {
    let state = recording.initial;
    const checkpoints = new Map(
      recording.checkpoints.map((snapshot) => [snapshot.seq, snapshot]),
    );
    let compared = 0;
    for (const delta of recording.deltas) {
      const step = applyAgentActivityMessage(state, {
        type: "delta",
        value: delta,
      });
      if (step.kind !== "state") throw new Error(`seq ${delta.seq}: ${step.kind}`);
      state = step.state;
      // A duplicate delivery changes nothing.
      expect(
        applyAgentActivityMessage(state, { type: "delta", value: delta }).kind,
      ).toBe("unchanged");
      const checkpoint = checkpoints.get(delta.seq);
      if (checkpoint) {
        expect(projectTimeline(state)).toEqual(projectTimeline(checkpoint));
        compared += 1;
      }
    }
    expect(compared > 0).toBe(true);
    expect(state).toEqual(recording.final);
  });

  test(`${name}: the projection merges tool updates by id and keeps one plan per turn`, () => {
    const turns = projectTimeline(recording.final);
    for (const turn of turns) {
      const ids = entryIds(turn.entries);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        turn.entries.filter((entry) => entry.kind === "plan").length <= 1,
      ).toBe(true);
    }
    const toolIds = recording.final.items
      .filter((item) => item.kind === "tool_call")
      .map((item) => item.id);
    const shown = turns.flatMap((turn) => entryIds(turn.entries));
    for (const id of toolIds) expect(shown.includes(id)).toBe(true);
  });

  test(`${name}: a permission's outcome shows in the row of its tool call`, () => {
    const turns = projectTimeline(recording.final);
    const rows = turns.flatMap((turn) =>
      turn.entries.flatMap((entry) => (entry.kind === "tools" ? entry.rows : [])),
    );
    for (const record of recording.final.items) {
      if (record.kind !== "interaction" || !record.toolCallId) continue;
      const row = rows.find((candidate) => candidate.item.id === record.toolCallId);
      expect(row?.permission?.id).toBe(record.id);
    }
  });

  test(`${name}: a finished turn folds and keeps the last answer outside`, () => {
    const turns = projectTimeline(recording.final);
    const finished = turns.filter((turn) => !turn.live && turn.summary);
    for (const turn of finished) {
      const visible = shownEntries({}, turn);
      const lastMessage = [...turn.entries]
        .reverse()
        .find((entry) => entry.kind === "message");
      if (lastMessage) {
        expect(visible.some((entry) => entry.id === lastMessage.id)).toBe(true);
      }
      expect(visible.length < turn.entries.length).toBe(true);
    }
  });
}
