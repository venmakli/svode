import type { AgentContextMcpFacts } from "./types";

/**
 * What a declaration starts: a local command with the package or command it
 * runs, or a remote server by its domain.
 */
export type AgentContextMcpSummary =
  | { kind: "local"; target: string }
  | { kind: "remote"; domain: string };

/** Runners whose first argument that is no flag names the package they run. */
const PACKAGE_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  bunx: [],
  npx: [],
  pnpx: [],
  uvx: [],
  bun: ["x"],
  npm: ["exec"],
  pipx: ["run"],
  pnpm: ["dlx"],
  yarn: ["dlx"],
};

export function agentContextMcpSummary(
  mcp: AgentContextMcpFacts,
): AgentContextMcpSummary | null {
  const [program, ...args] = mcp.command;
  if (program) return { kind: "local", target: localTarget(program, args) };
  if (mcp.url) return { kind: "remote", domain: urlDomain(mcp.url) };
  return null;
}

/** The command with its arguments as one line; an argument with spaces is quoted. */
export function agentContextMcpCommandText(command: readonly string[]) {
  return command
    .map((part) =>
      /[\s"']/.test(part) ? `'${part.replace(/'/g, "'\\''")}'` : part,
    )
    .join(" ");
}

function localTarget(program: string, args: readonly string[]) {
  const name = baseName(program).replace(/\.(exe|cmd|bat)$/i, "");
  const subcommand = PACKAGE_RUNNERS[name];
  if (subcommand) {
    const rest =
      subcommand.length > 0
        ? args[0] === subcommand[0]
          ? args.slice(1)
          : null
        : args;
    const target = rest?.find((arg) => !arg.startsWith("-"));
    if (target) return target;
  }
  return name || program;
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The host and port as declared; a declared variable keeps its case. */
function urlDomain(url: string) {
  const authority = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#]/)[0];
  return authority?.split("@").at(-1) || url;
}
