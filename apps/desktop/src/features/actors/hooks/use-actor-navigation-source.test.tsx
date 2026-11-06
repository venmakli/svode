import { expect, test } from "bun:test";

import type { AgentActorItem } from "../model/agent-actor-types";
import type { ActorCatalogItem } from "../model/types";
import {
  agentActorNavigationSource,
  personNavigationSource,
} from "./use-actor-navigation-source";

const ada: ActorCatalogItem = {
  aliases: [],
  availableYears: [],
  canonicalEmail: "ada@example.test",
  commitCount: 1,
  contribution: "contributor",
  displayName: "Ada Lovelace",
  lastActivityDate: null,
  lastCommitAt: null,
  sources: [],
};
const reviewer: AgentActorItem = {
  actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
  binding: { kind: "participant" },
  description: null,
  id: "01arz3ndektsv4rrffq69g5fav",
  inherited: false,
  mode: null,
  name: "Reviewer",
  ownerLabel: "Space",
  ownerPath: "/project/space",
  version: "v1",
};

test("the people source names its people and confirms absence only after a complete read", () => {
  const complete = personNavigationSource({
    diagnostics: [],
    generation: 1,
    items: [ada],
    repositoryId: "/repo",
    shallow: false,
  });
  expect(complete.items.get(ada.canonicalEmail)?.title).toBe("Ada Lovelace");
  expect(complete.confirmsAbsence).toBe(true);

  const unreadMailmap = personNavigationSource({
    diagnostics: [
      { blocking: true, kind: "unsafe_file", line: null, message: "" },
    ],
    generation: 2,
    items: [ada],
    repositoryId: "/repo",
    shallow: false,
  });
  expect(unreadMailmap.items.get(ada.canonicalEmail)?.title).toBe(
    "Ada Lovelace",
  );
  expect(unreadMailmap.confirmsAbsence).toBe(false);

  expect(
    personNavigationSource({
      diagnostics: [],
      generation: 3,
      items: [ada],
      repositoryId: "/repo",
      shallow: true,
    }).confirmsAbsence,
  ).toBe(false);
});

test("the Agent Actor source keeps rows while a catalog is unreadable and confirms absence once it is read", () => {
  const unreadable = agentActorNavigationSource({
    agents: [],
    diagnostics: [
      {
        code: "catalog_unavailable",
        message: "newer schema",
        ownerPath: "/project",
        reason: "newer_format",
      },
    ],
    fingerprints: {},
    items: [reviewer],
    launchSpacePath: "/project/space",
  });
  expect(unreadable.items.get(reviewer.id)?.title).toBe("Reviewer");
  expect(unreadable.confirmsAbsence).toBe(false);

  const read = agentActorNavigationSource({
    agents: [],
    diagnostics: [],
    fingerprints: {},
    items: [reviewer],
    launchSpacePath: "/project/space",
  });
  expect(read.items.get(reviewer.id)?.title).toBe("Reviewer");
  expect(read.confirmsAbsence).toBe(true);
});
