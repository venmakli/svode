import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type { AgentActorOptionsState } from "@/features/actors/agent-reference";
import { loadAgentAdapterIdentities } from "@/features/agent-adapters";

import { RoutineLaunchRefusedError } from "../model/launch-refusal";
import type { RoutineLaunchRefusal, RoutineRow } from "../model/types";
import { RoutineDetailActions } from "./routine-detail-actions";
import { RoutineDetailView } from "./routine-detail-view";

const ACTOR = "01arz3ndektsv4rrffq69g5fav";
const executors: AgentActorOptionsState = {
  ambiguous: [],
  error: null,
  incomplete: false,
  loading: false,
  options: [],
};
const routine: RoutineRow = {
  definition: {
    action: { executor: `agent:${ACTOR}`, type: "run_agent" },
    body: "Review changes.",
    description: "",
    enabled: null,
    name: "Daily summary",
    trigger: { type: "manual" },
  },
  definitionPath: ".routines/daily-summary.md",
  description: "",
  diagnostics: [],
  filename: "daily-summary.md",
  fingerprint: "fingerprint:1",
  id: "routine:summary",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  name: "Daily summary",
  nextRunAt: null,
  routineId: "routine:summary",
  valid: true,
};
const staleModel: RoutineLaunchRefusal = {
  agent: "codex",
  detail: null,
  reason: "setting_not_declared",
  recovery: "actor_editor",
  setting: "model",
  value: "gpt-5.6",
};
const noDefaultAgent: RoutineLaunchRefusal = {
  agent: null,
  detail: null,
  reason: "default_agent_not_set",
  recovery: "agent_settings",
  setting: null,
  value: null,
};

function refusedRun(refusal: RoutineLaunchRefusal): RoutineRow {
  return {
    ...routine,
    lastRun: {
      active: false,
      agentSessionId: "codex:launch:launch-one",
      launchId: "launch-one",
      ptyId: null,
      refusal,
      routineRunId: "run-one",
      sourceSessionId: null,
    },
    lastRunAt: "2026-11-01T10:00:00Z",
    lastRunOrigin: "local",
  };
}

async function withDom(body: (container: HTMLElement) => Promise<void>) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restore = installDomGlobals(dom);
  try {
    await body(dom.window.document.getElementById("app")!);
  } finally {
    restore();
  }
}

async function settle(action: () => unknown) {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no button ${label}: ${container.innerHTML}`);
  return found;
}

test("a manual run refused for a value names it and opens the Agent Actor's editor", async () => {
  await loadAgentAdapterIdentities(async () => [
    { displayName: "Codex", id: "codex" },
  ]);
  await withDom(async (container) => {
    const opened: string[] = [];
    const root = createRoot(container);
    await settle(() =>
      root.render(
        <RoutineDetailActions
          recovery={{
            onOpenAgentActor: (actorId) => opened.push(actorId),
            onOpenAgentSettings: () => opened.push("settings"),
          }}
          row={routine}
          runState={{ status: "idle" }}
          onOpenSession={() => undefined}
          onRun={async () => {
            throw new RoutineLaunchRefusedError("refused", staleModel);
          }}
        />,
      ),
    );
    await settle(() => button(container, "Run now").click());
    const alert = container.querySelector('[role="alert"]');
    expect(
      alert?.textContent?.includes(
        "Launch refused: Codex doesn't offer “gpt-5.6” for model",
      ),
    ).toBe(true);
    await settle(() => button(container, "Open Agent").click());
    expect(opened).toEqual([ACTOR]);
    await settle(() => root.unmount());
  });
});

test("a manual run refused at readiness keeps its reason when the detail opens again", async () => {
  await withDom(async (container) => {
    const opened: string[] = [];
    const root = createRoot(container);
    await settle(() =>
      root.render(
        <RoutineDetailActions
          recovery={{ onOpenAgentSettings: () => opened.push("settings") }}
          row={routine}
          runRefusal={noDefaultAgent}
          runState={{ message: "refused", status: "error" }}
          onOpenSession={() => undefined}
          onRun={async () => undefined}
        />,
      ),
    );
    expect(
      container
        .querySelector('[role="alert"]')
        ?.textContent?.includes(
          "Launch refused: no default agent is chosen on this device",
        ),
    ).toBe(true);
    await settle(() => button(container, "Agent settings").click());
    expect(opened).toEqual(["settings"]);
    await settle(() => root.unmount());
  });
});

test("the last run shows why its launch was refused, with no session to open", async () => {
  await loadAgentAdapterIdentities(async () => [
    { displayName: "Codex", id: "codex" },
  ]);
  const opened: string[] = [];
  const recovery = {
    onOpenAgentActor: (actorId: string) => opened.push(actorId),
    onOpenAgentSettings: () => opened.push("settings"),
  };
  const markup = renderToStaticMarkup(
    <RoutineDetailView
      executors={executors}
      recovery={recovery}
      row={refusedRun(staleModel)}
    />,
  );
  expect(
    markup.includes(
      "Launch refused: Codex doesn&#x27;t offer “gpt-5.6” for model",
    ),
  ).toBe(true);
  expect(markup.includes("Open Agent")).toBe(true);
  expect(
    renderToStaticMarkup(
      <RoutineDetailView
        executors={executors}
        recovery={recovery}
        row={refusedRun(noDefaultAgent)}
      />,
    ).includes("Agent settings"),
  ).toBe(true);

  await withDom(async (container) => {
    const root = createRoot(container);
    await settle(() =>
      root.render(
        <RoutineDetailActions
          recovery={recovery}
          row={refusedRun(staleModel)}
          runState={{ status: "idle" }}
          onOpenSession={() => undefined}
          onRun={async () => undefined}
        />,
      ),
    );
    expect(
      [...container.querySelectorAll("button")].map(
        (candidate) => candidate.textContent,
      ),
    ).toEqual(["Run now"]);
    await settle(() => root.unmount());
  });
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
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
