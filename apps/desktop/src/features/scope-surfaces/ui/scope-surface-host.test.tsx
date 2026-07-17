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

  expect(markup).toContain("Owner");
  expect(markup).toContain("Readme content");
  expect(markup).not.toContain('role="tablist"');
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
      initialSurfaceId="readme"
    />,
  );

  expect(markup).toContain('role="tablist"');
  expect(markup).toContain('role="tabpanel"');
  expect(markup).toContain("Readme content");
  expect(markup).not.toContain("Routines content");
});
