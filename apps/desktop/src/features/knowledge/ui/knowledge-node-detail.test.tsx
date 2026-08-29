import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { KnowledgeNeighbor } from "../model/projection";
import type { KnowledgeNode } from "../model/types";
import { KnowledgeNodeDetail } from "./knowledge-node-detail";

const node: KnowledgeNode = {
  id: "page:compliance:age-policy",
  source: {
    kind: "page",
    path: "policies/age-and-registration-policy.md",
    spaceId: "compliance",
  },
  spaceName: "compliance",
  title: "Age and registration policy with a deliberately long title",
  contentHash: "hash",
  sourceUpdatedAt: "2026-08-21T00:00:00.000Z",
  checkedAt: "2026-08-21T00:00:00.000Z",
  canonicalSourcePath: "compliance/policies/age-and-registration-policy.md",
  provenance: {},
};

const neighbors: KnowledgeNeighbor[] = [
  {
    key: "links_to:monetization",
    node: {
      ...node,
      id: "page:compliance:monetization",
      title: "Monetization BigQuest with a deliberately long relation name",
    },
    source: node.source,
    nodeId: "page:compliance:monetization",
    title: "Monetization BigQuest with a deliberately long relation name",
    targetStatus: "ready",
    edgeKinds: ["links_to"],
    fieldNames: [],
  },
];

test("constrains Page detail actions and relations to the Sidebar width", () => {
  const html = renderToStaticMarkup(
    <KnowledgeNodeDetail
      node={node}
      neighbors={neighbors}
      onBack={() => undefined}
      onSelectNode={() => undefined}
      onOpenSource={() => undefined}
    />,
  );
  const dom = new JSDOM(html);

  expect(
    hasClasses(dom, "[data-knowledge-node-detail-scroll]", [
      "[&_[data-slot=scroll-area-viewport]>div]:!block",
    ]),
  ).toBe(true);
  expect(
    hasClasses(dom, "[data-knowledge-node-detail]", [
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    ]),
  ).toBe(true);
  expect(
    hasClasses(dom, "[data-knowledge-open-source]", [
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    ]),
  ).toBe(true);
  expect(
    hasClasses(dom, "[data-knowledge-neighbor]", [
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
    ]),
  ).toBe(true);
  expect(html.includes(node.canonicalSourcePath)).toBe(true);
  expect(html.includes(neighbors[0].title)).toBe(true);
  dom.window.close();
});

function hasClasses(dom: JSDOM, selector: string, classes: string[]) {
  const element = dom.window.document.querySelector(selector);
  return classes.every((className) => element?.classList.contains(className));
}
