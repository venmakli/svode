import { expect, test } from "bun:test";

import { getSpaceSnapshot } from "../model/public-space";
import { useSpaceStore } from "../model/space-store";
import type { SpaceInfo } from "../model/types";
import { spaceNameResolver } from "./use-space-names";

test("a Space is named by its name, the project root by the project's, and a rename shows at once", () => {
  useSpaceStore.setState({
    activeRootName: "Acme",
    activeRootPath: "/repo",
    rootSpaces: [space("root", "Acme", "/repo")],
    spaces: [space("docs", "Documentation", "/repo/docs")],
  });
  const before = spaceNameResolver(getSpaceSnapshot());
  expect(before("/repo")).toBe("Acme");
  expect(before("/repo/docs")).toBe("Documentation");
  expect(before("/repo/docs/")).toBe("Documentation");
  expect(before("/repo/other")).toBeNull();

  // The renames of the sidebar and of the Space settings patch the store.
  useSpaceStore.getState().patchSpaceMetadata("/repo/docs", { name: "Guides" });
  useSpaceStore.getState().patchSpaceMetadata("/repo", { name: "Acme Inc" });
  const after = spaceNameResolver(getSpaceSnapshot());
  expect(after("/repo/docs")).toBe("Guides");
  expect(after("/repo")).toBe("Acme Inc");
});

function space(id: string, name: string, path: string): SpaceInfo {
  return {
    id,
    name,
    icon: "",
    description: "",
    path,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  };
}
