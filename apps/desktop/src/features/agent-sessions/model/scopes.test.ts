import { expect, test } from "bun:test";
import { listedSession } from "./testing/catalog";
import { buildAgentSessionScopes, isAgentSessionInScope } from "./scopes";

const [root, docs] = buildAgentSessionScopes({
  activeRootIcon: null,
  activeRootId: "root",
  activeRootName: "Project",
  activeRootPath: "/project",
  spaces: [
    {
      id: "docs",
      name: "Docs",
      icon: "",
      path: "/project/docs",
      status: "ready",
    },
  ],
});

test("a Space shows only its own sessions and the root not those of child Spaces", () => {
  const rootSession = listedSession({ id: "codex:root" });
  const docsSession = listedSession({
    id: "codex:docs",
    scopeKind: "space",
    spaceId: "docs",
    spacePath: "/project/docs",
  });
  const docsByPath = listedSession({
    id: "codex:path",
    scopeKind: "space",
    spacePath: "/project/docs",
  });
  const otherSpace = listedSession({
    id: "codex:other",
    scopeKind: "space",
    spaceId: "other",
    spacePath: "/project/other",
  });

  expect(root!.kind).toBe("project");
  expect(isAgentSessionInScope(rootSession, root!)).toBe(true);
  expect(isAgentSessionInScope(docsSession, root!)).toBe(false);
  expect(isAgentSessionInScope(docsSession, docs!)).toBe(true);
  expect(isAgentSessionInScope(docsByPath, docs!)).toBe(true);
  expect(isAgentSessionInScope(rootSession, docs!)).toBe(false);
  expect(isAgentSessionInScope(otherSpace, docs!)).toBe(false);
});
