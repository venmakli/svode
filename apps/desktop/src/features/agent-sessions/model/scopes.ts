import type {
  AgentSession,
  AgentSessionScopeGroup,
  AgentSessionScopeGroupStatus,
} from "./types";

export interface AgentSessionScopeSpace {
  id: string;
  name: string;
  icon: string;
  path: string;
  status: AgentSessionScopeGroupStatus;
}

export interface AgentSessionScopesInput {
  activeRootIcon: string | null;
  activeRootId: string | null;
  activeRootName: string | null;
  activeRootPath: string | null;
  spaces: readonly AgentSessionScopeSpace[];
}

/** The project root followed by every registered child Space. */
export function buildAgentSessionScopes({
  activeRootIcon,
  activeRootId,
  activeRootName,
  activeRootPath,
  spaces,
}: AgentSessionScopesInput): AgentSessionScopeGroup[] {
  const scopes: AgentSessionScopeGroup[] = [];

  if (activeRootId && activeRootPath) {
    scopes.push({
      id: projectScopeGroupId(activeRootPath),
      kind: "project",
      scopeId: activeRootId,
      name: activeRootName?.trim() || "Project",
      icon: activeRootIcon,
      path: activeRootPath,
      status: "ready",
    });
  }

  spaces.forEach((space) => {
    scopes.push({
      id: childSpaceScopeGroupId(space.id),
      kind: "space",
      scopeId: space.id,
      name: space.name,
      icon: space.icon,
      path: space.path,
      status: space.status,
    });
  });

  return scopes;
}

/**
 * Whether a session is one of the Space's own sessions by the scope resolver:
 * the project root holds its own sessions, not those of child Spaces.
 */
export function isAgentSessionInScope(
  session: AgentSession,
  scope: AgentSessionScopeGroup,
): boolean {
  if (scope.kind === "project") return session.scopeKind === "project";
  return (
    session.scopeKind === "space" &&
    (session.spaceId === scope.scopeId || session.spacePath === scope.path)
  );
}

function projectScopeGroupId(projectPath: string): string {
  return `space:project:${projectPath}`;
}

function childSpaceScopeGroupId(spaceId: string): string {
  return `space:${spaceId}`;
}
