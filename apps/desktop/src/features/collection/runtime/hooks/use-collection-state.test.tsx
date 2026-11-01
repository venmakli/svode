import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  defineCollectionPresentation,
  useCollectionState,
  type CollectionInstance,
} from "@/features/collection";

interface TestItem {
  id: string;
}

function presentation(id: string) {
  return defineCollectionPresentation<TestItem>({
    descriptor: {
      properties: [],
      getItemId: (item) => item.id,
      id,
      label: id,
      layout: {
        getTitle: (item) => item.id,
        kind: "list",
        visibleProperties: [],
      },
      query: {},
    },
    state: {
      phase: "ready",
      items: [{ id: "item:one" }],
    },
  });
}

test("public state hook blocks an invalid instance before selecting a presentation", () => {
  const instance: CollectionInstance = {
    defaultPresentationId: "missing",
    instanceKey: "space:root:actors",
    presentations: [presentation("actors"), presentation("actors")],
    stateScope: "session",
  };
  function Probe() {
    const state = useCollectionState(instance);
    return (
      <span data-phase={state.phase}>
        {state.phase === "blocking_error" ? state.diagnostics.join("|") : ""}
      </span>
    );
  }

  const markup = renderToStaticMarkup(<Probe />);

  expect(markup.includes('data-phase="blocking_error"')).toBe(true);
  expect(
    markup.includes("declares presentation &quot;actors&quot; more than once"),
  ).toBe(true);
});
