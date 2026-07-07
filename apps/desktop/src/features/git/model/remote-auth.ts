import type { GitAuthChallenge, GitRemoteOperation } from "./types";

export function gitAuthChallengeFromRemoteUrl({
  remoteUrl,
  operation,
  detail,
}: {
  remoteUrl: string;
  operation: GitRemoteOperation;
  detail?: string | null;
}): GitAuthChallenge {
  const safeRemoteUrl = redactUrlCredentials(remoteUrl);
  return {
    operation,
    authMethod: remoteAuthMethod(remoteUrl),
    remoteUrl: safeRemoteUrl,
    host: hostFromRemoteUrl(safeRemoteUrl),
    repository: repositoryFromRemoteUrl(safeRemoteUrl),
    providerHint: providerHintFromRemoteUrl(safeRemoteUrl),
    detail: detail ? trimDetail(redactUrlCredentials(detail)) : null,
  };
}

export function isGitAuthRequiredError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("git auth required") ||
    message.includes("authentication failed") ||
    message.includes("could not read username") ||
    message.includes("terminal prompts disabled") ||
    message.includes("permission denied") ||
    message.includes("missing credentials") ||
    message.includes("missing or invalid credentials")
  );
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function remoteAuthMethod(remoteUrl: string): GitAuthChallenge["authMethod"] {
  const lower = remoteUrl.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return "https";
  }
  if (lower.startsWith("ssh://") || looksLikeScpRemote(remoteUrl)) {
    return "ssh";
  }
  return "unknown";
}

function hostFromRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const withoutProtocol = remoteUrl.split("://").at(1);
  if (withoutProtocol) {
    const authority = withoutProtocol.split("/")[0] ?? "";
    return authority.split("@").at(-1) || null;
  }
  const scpHost = remoteUrl.split(":")[0] ?? "";
  return scpHost.split("@").at(-1) || null;
}

function repositoryFromRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const withoutProtocol = remoteUrl.split("://").at(1);
  const path = withoutProtocol
    ? withoutProtocol.split("/").slice(1).join("/")
    : remoteUrl.split(":").slice(1).join(":");
  const normalized = path.replace(/^\//, "").replace(/\/$/, "");
  if (!normalized) return null;
  return normalized.endsWith(".git") ? normalized.slice(0, -4) : normalized;
}

function providerHintFromRemoteUrl(remoteUrl: string | null): string | null {
  const host = hostFromRemoteUrl(remoteUrl)?.toLowerCase() ?? "";
  if (host.includes("github.com")) return "github";
  if (host.includes("gitlab.com")) return "gitlab";
  if (host.includes("gitea")) return "gitea";
  return null;
}

function redactUrlCredentials(text: string): string {
  let out = "";
  let rest = text;
  while (true) {
    const schemeIndex = rest.indexOf("://");
    if (schemeIndex === -1) break;

    out += rest.slice(0, schemeIndex + 3);
    rest = rest.slice(schemeIndex + 3);

    const authorityEnd = rest.search(/[/'\s]/);
    const end = authorityEnd === -1 ? rest.length : authorityEnd;
    const authority = rest.slice(0, end);
    const atIndex = authority.lastIndexOf("@");
    out += atIndex === -1 ? authority : `***@${authority.slice(atIndex + 1)}`;
    rest = rest.slice(end);
  }
  return out + rest;
}

function trimDetail(detail: string): string | null {
  const trimmed = detail.trim();
  if (!trimmed) return null;
  const maxChars = 1200;
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars)}\n...`
    : trimmed;
}

function looksLikeScpRemote(remoteUrl: string): boolean {
  if (remoteUrl.includes("://")) return false;
  const colonIndex = remoteUrl.indexOf(":");
  if (colonIndex === -1) return false;
  const hostPart = remoteUrl.slice(0, colonIndex);
  return hostPart.length > 0 && !hostPart.includes("/");
}
