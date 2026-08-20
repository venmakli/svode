import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type { AgentContextSkillRow } from "../model/types";
import { AgentContextSkillFrontmatterDisclosure } from "./skill-frontmatter-disclosure";

const skill: AgentContextSkillRow = {
  allowedTools: "Read Bash(git:*)",
  aliases: [
    {
      discoveryPath: "/workspace/.agents/skills/review",
      linkKind: "direct",
      location: "space",
      resolution: "selected",
      sourceFamily: "agents",
      support: "client_native",
    },
  ],
  body: "# Review",
  canonicalPath: "/workspace/.agents/skills/review",
  compatibility: "Requires git and network access",
  description: "Review project changes.",
  health: "normal",
  healthReasons: [],
  id: "skill:/workspace/.agents/skills/review",
  license: "MIT",
  manifestPath: "/workspace/.agents/skills/review/SKILL.md",
  metadata: { zeta: "last", alpha: "first" },
  name: "review",
  ownerPath: "/workspace",
  truncated: false,
};

test("frontmatter disclosure is absent without normalized optional values", () => {
  const markup = renderToStaticMarkup(
    <AgentContextSkillFrontmatterDisclosure
      row={{
        ...skill,
        allowedTools: null,
        compatibility: null,
        license: null,
        metadata: {},
      }}
    />,
  );

  expect(markup).toBe("");
});

test("frontmatter disclosure preserves all fields, deterministic metadata, and per-artifact state", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await render(skill);

    let trigger = frontmatterTrigger(dom);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dom.window.document.body.textContent?.includes("MIT")).toBe(false);

    trigger.focus();
    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });

    trigger = frontmatterTrigger(dom);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dom.window.document.activeElement).toBe(trigger);
    expect(frontmatterTerms(dom)).toEqual([
      "License",
      "Compatibility",
      "Allowed tools (experimental)",
      "alpha",
      "zeta",
    ]);
    expect(
      dom.window.document.body.textContent?.includes("Read Bash(git:*)"),
    ).toBe(true);
    expect(
      dom.window.document.body.textContent?.includes(
        "A client-defined source value.",
      ),
    ).toBe(true);

    await render({
      ...skill,
      metadata: { zeta: "last", alpha: "updated" },
    });
    expect(frontmatterTrigger(dom).getAttribute("aria-expanded")).toBe("true");
    expect(dom.window.document.body.textContent?.includes("updated")).toBe(
      true,
    );

    await render({ ...skill, id: "skill:/workspace/.agents/skills/write" });
    expect(frontmatterTrigger(dom).getAttribute("aria-expanded")).toBe("false");
    expect(dom.window.document.body.textContent?.includes("MIT")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }

  async function render(row: AgentContextSkillRow) {
    await act(async () => {
      root.render(<AgentContextSkillFrontmatterDisclosure row={row} />);
    });
  }
});

function frontmatterTrigger(dom: JSDOM): HTMLButtonElement {
  return dom.window.document.querySelector(
    "[data-agent-context-skill-frontmatter] button",
  )!;
}

function frontmatterTerms(dom: JSDOM): string[] {
  return Array.from(
    dom.window.document.querySelectorAll(
      "[data-agent-context-skill-frontmatter] dt",
    ),
  ).map((term) => term.textContent ?? "");
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
