import { expect, test } from "bun:test";

import {
  agentContextMcpCommandText,
  agentContextMcpSummary,
} from "./mcp-server";

const local = (command: string[]) => ({
  command,
  projectOnly: false,
  url: null,
});

test("a local server names the package its runner starts, else its command", () => {
  expect(agentContextMcpSummary(local(["npx", "-y", "@scope/server"]))).toEqual(
    {
      kind: "local",
      target: "@scope/server",
    },
  );
  expect(agentContextMcpSummary(local(["pnpm", "dlx", "tool-mcp"]))).toEqual({
    kind: "local",
    target: "tool-mcp",
  });
  expect(agentContextMcpSummary(local(["uvx", "mcp-server-fetch"]))).toEqual({
    kind: "local",
    target: "mcp-server-fetch",
  });
  expect(
    agentContextMcpSummary(local(["/Users/me/.svode/bin/svode-mcp"])),
  ).toEqual({ kind: "local", target: "svode-mcp" });
  expect(agentContextMcpSummary(local(["bun", "run", "server.ts"]))).toEqual({
    kind: "local",
    target: "bun",
  });
});

test("a remote server names its domain", () => {
  expect(
    agentContextMcpSummary({
      command: [],
      projectOnly: false,
      url: "https://mcp.example.com:8443/v1/sse",
    }),
  ).toEqual({ domain: "mcp.example.com:8443", kind: "remote" });
  expect(
    agentContextMcpSummary({
      command: [],
      projectOnly: false,
      url: "https://${HOST}/mcp",
    }),
  ).toEqual({ domain: "${HOST}", kind: "remote" });
  expect(
    agentContextMcpSummary({ command: [], projectOnly: false, url: null }),
  ).toBeNull();
});

test("the command is one line with arguments that hold spaces quoted", () => {
  expect(
    agentContextMcpCommandText(["docker", "run", "-e", "A B", "it's"]),
  ).toBe("docker run -e 'A B' 'it'\\''s'");
});
