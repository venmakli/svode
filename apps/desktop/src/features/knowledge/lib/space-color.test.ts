import { expect, test } from "bun:test";
import {
  knowledgeSpaceColorKey,
  knowledgeSpaceColorMap,
} from "./space-color";

test("visible spaces receive stable contrasting colors in projection order", () => {
  const ids = [null, "support", "develop", "compliance", "marketing"];
  const colors = knowledgeSpaceColorMap(ids);
  const assigned = ids.map((id) => colors.get(knowledgeSpaceColorKey(id)));

  expect(new Set(assigned).size).toBe(ids.length);
  expect(knowledgeSpaceColorMap(ids).get(knowledgeSpaceColorKey("develop"))).toBe(
    colors.get(knowledgeSpaceColorKey("develop")),
  );
});
