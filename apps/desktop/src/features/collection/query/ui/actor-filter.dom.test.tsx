import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act, useCallback, useState } from "react";
import type { ActorCandidate } from "@/features/properties";
import { createTestDom } from "@/shared/testing/dom";
import type { QueryFilter } from "../model/types";

if (process.env.SVODE_AVATAR_DOM_PROCESS !== "1") {
  test("isolated avatar DOM integration 1", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AVATAR_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("filter and property avatar parity survives identity updates without changing filter intent", async () => {
    const dom = await createTestDom();
    const { ActorSingleValue } = await import("@/features/properties/display");
    const { FilterEditor } = await import("./query-controls");
    const changes: QueryFilter[] = [];
    const actor = {
      name: "Ada Lovelace",
      email: "person3@example.test",
      aliasEmails: ["old@example.test"],
    };
    try {
      for (const name of ["Ada Lovelace", "Илья Камнев", " "]) {
        actor.name = name;
        await dom.render(
          <>
            <ActorSingleValue value={actor.email} actors={[actor]} />
            <FilterEditor
              schema={{ columns: [{ name: "People", type: "actor" }] }}
              draft={{
                field: "People",
                op: "in",
                values: ["old@example.test"],
              }}
              actors={[actor]}
              onChange={(value) => {
                changes.push(value);
              }}
            />
          </>,
        );
        const avatars = [
          ...dom.document.querySelectorAll<HTMLElement>(
            '[data-slot="avatar-fallback"]',
          ),
        ];
        expect(avatars.length).toBe(2);
        expect(avatars[1].textContent).toBe(avatars[0].textContent);
        expect(avatars[1].getAttribute("style")).toBe(
          avatars[0].getAttribute("style"),
        );
        expect(
          dom.document.querySelector("img, [data-slot=avatar-image]"),
        ).toBeNull();
      }
      const checkbox =
        dom.document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
      expect(checkbox.getAttribute("data-state")).toBe("checked");
      await act(async () => {
        checkbox.click();
      });
      expect(changes).toEqual([
        { field: "People", op: "in", value: undefined, values: [] },
      ]);
    } finally {
      await dom.dispose();
    }
  });
  test("an agent filter lists selectable agents by name and stores their reference", async () => {
    const dom = await createTestDom();
    const { FilterEditor } = await import("./query-controls");
    const changes: QueryFilter[] = [];
    const ref = "agent:01arz3ndektsv4rrffq69g5fav";
    const actors = [
      { kind: "agent" as const, name: "Writer", reference: ref },
      {
        kind: "agent" as const,
        name: "Analyst",
        reference: "agent:01bx5zzkbkactav9wevgemmvrz",
      },
      {
        kind: "agent" as const,
        name: "Loading agent…",
        reference: "agent:01c0000000000000000000000z",
        state: "loading" as const,
      },
    ];
    try {
      await dom.render(
        <FilterEditor
          schema={{ columns: [{ name: "Agent", type: "actor" }] }}
          draft={{ field: "Agent", op: "in", values: [] }}
          actors={actors}
          onChange={(value) => {
            changes.push(value);
          }}
        />,
      );
      const labels = () =>
        [...dom.document.querySelectorAll("label")].map(
          (label) => label.textContent,
        );
      expect(labels()).toEqual(["Writer", "Analyst"]);
      expect(
        dom.document.querySelectorAll('[data-agent-avatar="neutral"]').length,
      ).toBe(2);

      const search = dom.document.querySelector<HTMLInputElement>("input")!;
      const type = async (value: string) => {
        const view = search.ownerDocument.defaultView!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            view.HTMLInputElement.prototype,
            "value",
          )?.set?.call(search, value);
          search.dispatchEvent(new view.Event("input", { bubbles: true }));
        });
      };
      await type("01arz");
      expect(labels()).toEqual([]);
      await type("writ");
      expect(labels()).toEqual(["Writer"]);

      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>('[role="checkbox"]')!
          .click();
      });
      expect(changes).toEqual([
        { field: "Agent", op: "in", value: undefined, values: [ref] },
      ]);
    } finally {
      await dom.dispose();
    }
  });
  test("an actor filter requests people when shown and tells loading, the list and an empty catalog apart", async () => {
    const dom = await createTestDom();
    const { m, Host, deferred, stateText } = await actorHostKit(dom);
    try {
      const people = deferred();
      let calls = 0;
      await dom.render(
        <Host
          source={() => {
            calls += 1;
            return people.promise;
          }}
        />,
      );
      expect(calls).toBe(1);
      expect(stateText()).toBe(m.view_query_actors_loading());
      await act(async () => {
        dom.document.querySelector<HTMLInputElement>("input")!.focus();
      });
      expect(calls).toBe(1);
      await act(async () => people.resolve([ada, grace]));
      expect(labels(dom)).toEqual(["Ada Lovelace", "Grace Hopper"]);
      expect(stateText()).toBeNull();

      await typeSearch(dom, "zzz");
      expect(labels(dom)).toEqual([]);
      expect(stateText()).toBe(m.view_query_actors_no_matches());
      await typeSearch(dom, "grace@");
      expect(labels(dom)).toEqual(["Grace Hopper"]);

      await dom.render(null);
      const empty = deferred();
      await dom.render(<Host source={() => empty.promise} />);
      await act(async () => empty.resolve([]));
      expect(stateText()).toBe(m.view_query_actors_empty());
      expect(dom.document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await dom.dispose();
    }
  });

  test("known candidates show at once and a cached source never flashes loading", async () => {
    const dom = await createTestDom();
    const { Host, stateText } = await actorHostKit(dom);
    try {
      let calls = 0;
      await dom.render(
        <Host
          initial={[ada]}
          source={async () => {
            calls += 1;
            return [ada];
          }}
        />,
      );
      expect(calls).toBe(1);
      expect(labels(dom)).toEqual(["Ada Lovelace"]);
      expect(stateText()).toBeNull();
    } finally {
      await dom.dispose();
    }
  });

  test("a failed request offers Retry, which loads again, and keeps already known candidates", async () => {
    const dom = await createTestDom();
    const { m, Host, deferred, stateText } = await actorHostKit(dom);
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const attempts = [deferred(), deferred()];
      let calls = 0;
      await dom.render(<Host source={() => attempts[calls++].promise} />);
      await act(async () => attempts[0].reject(new Error("backend detail")));
      const alert = dom.document.querySelector('[role="alert"]')!;
      expect(alert.textContent).toBe(
        m.view_query_actors_load_failed() + m.view_query_actors_retry(),
      );
      expect(stateText()).toBeNull();
      expect(logged.length).toBe(1);
      expect(
        dom.document.querySelector<HTMLInputElement>("input")!.disabled,
      ).toBe(false);

      const retry = alert.querySelector<HTMLButtonElement>("button")!;
      expect(retry.textContent).toBe(m.view_query_actors_retry());
      await act(async () => retry.click());
      expect(calls).toBe(2);
      expect(dom.document.querySelector('[role="alert"]')).toBeNull();
      expect(stateText()).toBe(m.view_query_actors_loading());
      await act(async () => attempts[1].resolve([ada]));
      expect(labels(dom)).toEqual(["Ada Lovelace"]);

      await dom.render(null);
      const failing = deferred();
      await dom.render(
        <Host initial={[grace]} source={() => failing.promise} />,
      );
      await act(async () => failing.reject(new Error("offline")));
      expect(labels(dom)).toEqual(["Grace Hopper"]);
      expect(dom.document.querySelector('[role="alert"]')).toBeNull();
      expect(stateText()).toBeNull();
    } finally {
      console.error = originalError;
      await dom.dispose();
    }
  });

  test("a response after the editor closes or its source changes has no effect", async () => {
    const dom = await createTestDom();
    const { m, FilterEditor, deferred, stateText } = await actorHostKit(dom);
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const first = deferred();
      const second = deferred();
      const sourceA = () => first.promise;
      const sourceB = () => second.promise;
      const editor = (source: () => Promise<ActorCandidate[]>) => (
        <FilterEditor
          schema={{ columns: [{ name: "Owner", type: "actor" }] }}
          draft={{ field: "Owner", op: "in", values: [] }}
          actors={[]}
          onRequestActors={source}
          onChange={() => {}}
        />
      );
      await dom.render(editor(sourceA));
      await dom.render(editor(sourceB));
      await act(async () => first.resolve([]));
      expect(stateText()).toBe(m.view_query_actors_loading());
      await dom.render(null);
      await act(async () => second.reject(new Error("late")));
      expect(dom.document.querySelector('[role="alert"]')).toBeNull();
      expect(
        logged.filter((args) => !String(args[0]).startsWith("Failed")),
      ).toEqual([]);
    } finally {
      console.error = originalError;
      await dom.dispose();
    }
  });

  test("fixed collection candidates show without a request, loading or error", async () => {
    const dom = await createTestDom();
    const { m, FilterEditor, stateText } = await actorHostKit(dom);
    try {
      const render = (actors: ActorCandidate[]) =>
        dom.render(
          <FilterEditor
            schema={{ columns: [{ name: "Owner", type: "actor" }] }}
            draft={{ field: "Owner", op: "in", values: [] }}
            actors={actors}
            onChange={() => {}}
          />,
        );
      await render([ada]);
      expect(labels(dom)).toEqual(["Ada Lovelace"]);
      expect(stateText()).toBeNull();
      await render([]);
      expect(stateText()).toBe(m.view_query_actors_empty());
      expect(dom.document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await dom.dispose();
    }
  });
}

const ada = { name: "Ada Lovelace", email: "ada@example.test" };
const grace = { name: "Grace Hopper", email: "grace@example.test" };

type TestDom = Awaited<ReturnType<typeof createTestDom>>;

function labels(dom: TestDom) {
  return [...dom.document.querySelectorAll("label")].map(
    (label) => label.lastElementChild?.textContent,
  );
}

async function typeSearch(dom: TestDom, value: string) {
  const search = dom.document.querySelector<HTMLInputElement>("input")!;
  const view = search.ownerDocument.defaultView!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      view.HTMLInputElement.prototype,
      "value",
    )?.set?.call(search, value);
    search.dispatchEvent(new view.Event("input", { bubbles: true }));
  });
}

async function actorHostKit(dom: TestDom) {
  const m = await import("@/paraglide/messages.js");
  const { FilterEditor } = await import("./query-controls");

  // Mirrors useCollectionActors: the host keeps the list it last received.
  function Host({
    source,
    initial = [],
  }: {
    source: () => Promise<ActorCandidate[]>;
    initial?: ActorCandidate[];
  }) {
    const [actors, setActors] = useState(initial);
    const request = useCallback(async () => {
      const list = await source();
      setActors(list);
      return list;
    }, [source]);
    return (
      <FilterEditor
        schema={{ columns: [{ name: "Owner", type: "actor" }] }}
        draft={{ field: "Owner", op: "in", values: [] }}
        actors={actors}
        onRequestActors={request}
        onChange={() => {}}
      />
    );
  }

  function deferred() {
    let resolve!: (list: ActorCandidate[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ActorCandidate[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const stateText = () =>
    dom.document.querySelector('[role="status"]')?.textContent ?? null;

  return { m, FilterEditor, Host, deferred, stateText };
}
