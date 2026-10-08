import { expect, test } from "bun:test";
import type {
  AgentActivityItemDto,
  AgentPendingInteractionDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { getLocale, setLocale } from "@/paraglide/runtime";
import {
  commandProgram,
  liveTurnActivity,
  liveTurnCaption,
  urlDomain,
} from "./live-turn";

type Snapshot = Pick<AgentSessionSnapshotDto, "items" | "turn" | "pending">;

function item(
  id: string,
  kind: Record<string, unknown>,
  { status = "completed", summary = "", turnId = "t2" } = {},
): AgentActivityItemDto {
  return {
    id,
    turnId,
    status,
    summary,
    hasDetail: false,
    ...kind,
  } as AgentActivityItemDto;
}

function tool(
  id: string,
  toolKind: string,
  {
    status = "in_progress",
    summary = "",
    paths = [] as string[],
    mcp = [] as string[],
  } = {},
): AgentActivityItemDto {
  return item(
    id,
    {
      kind: "tool_call",
      tool: toolKind,
      media: [],
      locations: paths.map((path) => ({ path, change: null, lines: null })),
      mcpCalls: mcp.map((name) => ({
        server: "svode",
        tool: name,
        changesProject: true,
      })),
    },
    { status, summary },
  );
}

function snapshot(
  items: AgentActivityItemDto[],
  {
    phase = "running" as Snapshot["turn"]["phase"],
    pending = null as AgentPendingInteractionDto | null,
  } = {},
): Snapshot {
  return {
    turn: {
      turnId: "t2",
      phase,
      lastOutcome: null,
      status: {
        state: "running",
        source: "svode_runtime",
        confidence: "exact",
      },
    } as Snapshot["turn"],
    pending,
    items: [
      item("u1", { kind: "user_message", segments: [] }, { turnId: "t1" }),
      item("m1", { kind: "agent_message", media: [] }, { turnId: "t1" }),
      item("u2", { kind: "user_message", segments: [] }),
      ...items,
    ],
  };
}

/** The caption in Russian, as the contract words it. */
function caption(value: Snapshot): string | null {
  const activity = liveTurnActivity(value);
  if (!activity) return null;
  const locale = getLocale();
  setLocale("ru", { reload: false });
  try {
    return liveTurnCaption(activity);
  } finally {
    setLocale(locale, { reload: false });
  }
}

test("there is no marker between turns", () => {
  expect(liveTurnActivity(snapshot([], { phase: "none" }))).toBe(null);
});

test("a turn just sent works, thinks while reasoning, writes while the answer streams", () => {
  expect(caption(snapshot([]))).toBe("Работает");
  expect(caption(snapshot([item("r", { kind: "reasoning" })]))).toBe("Думает");
  expect(
    caption(
      snapshot([
        tool("a", "read", { status: "completed", paths: ["/p/a.md"] }),
        item("m", { kind: "agent_message", media: [] }),
      ]),
    ),
  ).toBe("Пишет ответ");
});

test("a command names its program without arguments", () => {
  expect(
    caption(
      snapshot([tool("x", "execute", { summary: "Run git status --short" })]),
    ),
  ).toBe("Выполняет git");
  expect(
    caption(
      snapshot([
        tool("x", "execute", {
          summary: "`FOO=1 /usr/local/bin/cargo test -p svode-agents --all`",
        }),
      ]),
    ),
  ).toBe("Выполняет cargo");
  // A title that is not a command line gives no program.
  expect(
    caption(
      snapshot([
        tool("x", "execute", { summary: "List files in the project" }),
      ]),
    ),
  ).toBe("Выполняет команду");
  expect(
    caption(snapshot([tool("x", "execute", { summary: "Terminal" })])),
  ).toBe("Выполняет команду");
});

test("read and edit name the file without its directories", () => {
  expect(
    caption(
      snapshot([
        tool("r", "read", {
          paths: ["/Users/me/project/notes/weekly-dev-status.md"],
        }),
      ]),
    ),
  ).toBe("Читает · weekly-dev-status.md");
  for (const kind of ["edit", "delete", "move"]) {
    expect(
      caption(
        snapshot([tool("e", kind, { paths: ["C:\\work\\src\\main.rs"] })]),
      ),
    ).toBe("Редактирует · main.rs");
  }
  expect(caption(snapshot([tool("r", "read")]))).toBe("Читает");
  expect(caption(snapshot([tool("e", "edit")]))).toBe("Редактирует");
});

test("search, fetch with its domain and other kinds", () => {
  expect(
    caption(snapshot([tool("s", "search", { summary: "grep -r foo /p" })])),
  ).toBe("Ищет");
  expect(
    caption(
      snapshot([
        tool("f", "fetch", {
          summary: "Fetch https://docs.example.com/a/b?q=1",
        }),
      ]),
    ),
  ).toBe("Загружает · docs.example.com");
  expect(
    caption(snapshot([tool("f", "fetch", { summary: "Searching the Web" })])),
  ).toBe("Загружает");
  for (const kind of ["other", "think", "switch_mode", "unknown"]) {
    expect(caption(snapshot([tool("o", kind, { summary: "Something" })]))).toBe(
      "Работает",
    );
  }
});

test("a recognized MCP call names its tool whatever its kind", () => {
  // Codex sends an MCP call with kind `execute`.
  expect(
    caption(
      snapshot([
        tool("c", "execute", {
          summary: "mcp.svode.write_page",
          mcp: ["write_page"],
        }),
      ]),
    ),
  ).toBe("Вызывает write_page");
  expect(
    caption(snapshot([tool("c", "other", { mcp: ["create_page"] })])),
  ).toBe("Вызывает create_page");
  // An unrecognized call stays with its kind, even with a lookalike title.
  expect(
    caption(
      snapshot([tool("c", "other", { summary: "mcp__svode__write_page" })]),
    ),
  ).toBe("Работает");
});

test("concurrent tool calls are counted; finished ones and earlier text do not count", () => {
  expect(
    caption(
      snapshot([
        tool("a", "read", { status: "pending", paths: ["/p/a"] }),
        tool("b", "read", { status: "in_progress", paths: ["/p/b"] }),
        tool("c", "execute", { summary: "Run ls" }),
      ]),
    ),
  ).toBe("Выполняет действий: 3");
  expect(
    caption(
      snapshot([
        tool("a", "read", { status: "in_progress", paths: ["/p/a.md"] }),
        tool("b", "read", { status: "completed", paths: ["/p/b.md"] }),
      ]),
    ),
  ).toBe("Читает · a.md");
  // A call left pending before the agent's text is not what it does now.
  expect(
    caption(
      snapshot([
        tool("a", "read", { status: "pending", paths: ["/p/a.md"] }),
        item("m", { kind: "agent_message", media: [] }),
        tool("b", "execute", { summary: "`npm test`" }),
      ]),
    ),
  ).toBe("Выполняет npm");
  expect(
    caption(
      snapshot([tool("a", "read", { status: "completed", paths: ["/p/a"] })]),
    ),
  ).toBe("Работает");
});

test("an open request waits for the user, and stopping wins over all", () => {
  const pending = { id: "q" } as AgentPendingInteractionDto;
  const items = [tool("a", "execute", { summary: "Run git push" })];
  expect(caption(snapshot(items, { pending }))).toBe("Ждёт вашего ответа");
  expect(caption(snapshot(items, { phase: "cancelling", pending }))).toBe(
    "Останавливается",
  );
});

test("the caption never carries arguments, directories or command text", () => {
  const long = `\`git commit -m "${"x".repeat(600)}" /Users/me/secret/dir\``;
  const text = caption(snapshot([tool("x", "execute", { summary: long })]));
  expect(text).toBe("Выполняет git");
  expect(commandProgram("`./scripts/build.sh --release`")).toBe("build.sh");
  expect(commandProgram("Run `rg -n foo`")).toBe("rg");
  // Cut short by the title bound, without the closing backtick.
  expect(commandProgram("`python3 -c 'print(1)' …")).toBe("python3");
  expect(commandProgram("`$(evil) arg`")).toBe(null);
  expect(urlDomain("Fetch ftp://example.com")).toBe(null);
});
