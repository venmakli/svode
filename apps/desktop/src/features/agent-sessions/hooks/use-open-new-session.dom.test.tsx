import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useEffect } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_OPEN_NEW_SESSION_DOM !== "1") {
  test("open new session DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_OPEN_NEW_SESSION_DOM: "1" },
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
  const dom = await createTestDom();

  let offer: "available" | "outdated" = "outdated";
  const started: string[] = [];
  const realChat = await import("../chat/api/chat");
  mock.module("../chat/api/chat", () => ({
    ...realChat,
    listChatAgents: async () => ({
      agents: [{ agent: "codex", name: "Codex", offer: { state: offer } }],
      last: null,
    }),
  }));
  mock.module("./use-start-agent-session", () => ({
    useStartAgentSession: () => async (spacePath: string) => {
      started.push(spacePath);
      return { sessionId: "pending:pty", launchId: null };
    },
  }));

  const { useOpenNewSession } = await import("./use-open-new-session");
  let open: ReturnType<typeof useOpenNewSession> | null = null;
  function Probe() {
    const openNewSession = useOpenNewSession();
    useEffect(() => {
      open = openNewSession;
    }, [openNewSession]);
    return null;
  }
  await dom.render(<Probe />);

  test("without a chat agent New session opens the managed terminal", async () => {
    offer = "outdated";
    started.length = 0;
    expect(await open!("/project/docs")).toEqual({
      kind: "terminal",
      target: { sessionId: "pending:pty", launchId: null },
    });
    expect(started).toEqual(["/project/docs"]);
  });

  test("with a chat agent New session opens a draft and starts no terminal", async () => {
    offer = "available";
    started.length = 0;
    const opening = await open!("/project/docs");
    expect(opening?.kind).toBe("draft");
    expect(
      opening?.kind === "draft" ? opening.draft.spacePath : null,
    ).toBe("/project/docs");
    expect(started).toEqual([]);
    await dom.dispose();
  });
}
