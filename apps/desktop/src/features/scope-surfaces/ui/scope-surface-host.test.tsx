import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScopeSurfaceContribution } from "../model/types";
import { createRegisteredSpaceOwner } from "../model/owners";
import { ScopeSurfaceHost } from "./scope-surface-host";

const owner = createRegisteredSpaceOwner({
  spaceId: "root",
  projectPath: "/repo",
  spacePath: "/repo",
  status: "ready",
  hasSchema: false,
});

function contribution(
  id: ScopeSurfaceContribution["id"],
  label: string,
): ScopeSurfaceContribution {
  return {
    id,
    label,
    order: 0,
    presentations: ["full", "compact"],
    appliesTo: () => true,
    icon: () => null,
    render: () => <div>{`${label} content`}</div>,
  };
}

test("keeps the only available surface mounted without rendering tabs", () => {
  const markup = renderToStaticMarkup(
    <ScopeSurfaceHost
      owner={owner}
      presentation="full"
      contributions={[contribution("readme", "Readme")]}
      header={<header>Owner</header>}
    />,
  );

  expect(markup.includes("Owner")).toBe(true);
  expect(markup.includes("Readme content")).toBe(true);
  expect(markup.includes('role="tablist"')).toBe(false);
});

test("renders shadcn tabs with only the active surface viewport mounted", () => {
  const markup = renderToStaticMarkup(
    <ScopeSurfaceHost
      owner={owner}
      presentation="full"
      contributions={[
        contribution("readme", "Readme"),
        contribution("routines", "Routines"),
      ]}
      header={<header>Owner</header>}
    />,
  );

  expect(markup.includes('role="tablist"')).toBe(true);
  expect(markup.includes('role="tabpanel"')).toBe(true);
  expect(markup.includes("Readme content")).toBe(true);
  expect(markup.includes("Routines content")).toBe(false);
});

test("compact host filters unavailable surfaces and honors its local selection", () => {
  const markup = renderToStaticMarkup(
    <ScopeSurfaceHost
      owner={owner}
      presentation="compact"
      contributions={[
        contribution("readme", "Readme"),
        contribution("collection", "Collection"),
        {
          ...contribution("agent", "Agent"),
          presentations: ["full"],
        },
      ]}
      compactSurfaceId="collection"
      header={<header>Owner</header>}
    />,
  );

  expect(markup.includes("Collection content")).toBe(true);
  expect(markup.includes("Readme content")).toBe(false);
  expect(markup.includes("Agent content")).toBe(false);
});
