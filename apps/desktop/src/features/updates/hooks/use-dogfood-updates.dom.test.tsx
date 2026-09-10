import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import {
  DogfoodUpdatesProvider,
  useDogfoodUpdates,
} from "./use-dogfood-updates";
import { DogfoodUpdateSettingsControls } from "../ui/update-settings-controls";

interface TestSpy<F extends (...args: never[]) => unknown> {
  mock: { calls: Parameters<F>[] };
  mockImplementation(fn: (...args: Parameters<F>) => ReturnType<F>): TestSpy<F>;
  mockReturnValue(value: ReturnType<F>): TestSpy<F>;
  mockRestore(): void;
}

const { beforeEach, afterEach, spyOn } = bunTest as typeof bunTest & {
  beforeEach(callback: () => void): void;
  afterEach(callback: () => Promise<void>): void;
  spyOn<T, K extends keyof T>(
    object: T,
    key: K,
  ): TestSpy<Extract<T[K], (...args: never[]) => unknown>>;
};

const LAST_CHECK = "svode.updates.dogfood.lastCheckAt";
const LAST_NOTIFIED = "svode.updates.dogfood.lastNotifiedId";
const INTERVAL = 12 * 60 * 60 * 1000;
let dom: JSDOM;
let root: Root;
let restore: () => void;
let now: number;
let timers: Map<number, { at: number; run: () => void }>;
let requests: {
  signal?: AbortSignal | null;
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
}[];
let urls: string[];
let failOpen: (url: string) => boolean;
let first: ReturnType<typeof useDogfoodUpdates>;
let second: ReturnType<typeof useDogfoodUpdates>;
let mounts: number;
let spies: ReturnType<typeof setupSpies>;

function setupSpies() {
  return {
    fetch: spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) =>
        new Promise<Response>((resolve, reject) => {
          requests.push({ signal: options?.signal, resolve, reject });
        }),
    ),
    date: spyOn(Date, "now").mockImplementation(() => now),
    info: spyOn(toast, "info").mockReturnValue(100),
    success: spyOn(toast, "success").mockReturnValue(200),
    error: spyOn(toast, "error").mockReturnValue(300),
    dismiss: spyOn(toast, "dismiss").mockReturnValue(400),
    console: spyOn(console, "error").mockImplementation(() => {}),
  };
}

beforeEach(() => {
  dom = new JSDOM("<div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  restore = () => {
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  now = Date.parse("2026-09-10T00:00:00Z");
  timers = new Map();
  let timerId = 0;
  dom.window.setTimeout = ((run: () => void, delay: number) => {
    timers.set(++timerId, { at: now + delay, run });
    return timerId;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id) => {
    timers.delete(id!);
  };
  requests = [];
  urls = [];
  mounts = 0;
  failOpen = () => false;
  spies = setupSpies();
  mockNativeIpc((command, args) => {
    if (command !== "plugin:shell|open")
      throw new Error(`Unexpected command: ${command}`);
    const path = (args as { path: string }).path;
    urls.push(path);
    if (failOpen(path)) throw new Error("opener failed");
  });
  root = createRoot(dom.window.document.getElementById("app")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearNativeMocks();
  for (const spy of Object.values(spies)) spy.mockRestore();
  restore();
  dom.window.close();
});

function Consumer({ slot }: { slot: "first" | "second" }) {
  const updates = useDogfoodUpdates();
  if (slot === "first") first = updates;
  else second = updates;
  useEffect(() => {
    mounts++;
  }, []);
  return (
    <div data-consumer={slot}>
      <DogfoodUpdateSettingsControls />
    </div>
  );
}

async function render({
  version = "0.0.8",
  commit = "installed",
  project = "one",
  about = true,
  strict = false,
} = {}) {
  const tree = (
    <DogfoodUpdatesProvider version={version} buildCommit={commit}>
      <Consumer slot="first" />
      {about && <Consumer slot="second" key={project} />}
    </DogfoodUpdatesProvider>
  );
  await act(async () =>
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree),
  );
}

async function advance(ms: number) {
  await act(async () => {
    now += ms;
    for (const [id, timer] of [...timers])
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
  });
}

async function answer(
  index: number,
  version: string | null = "0.0.9",
  status = 200,
) {
  await act(async () =>
    requests[index].resolve(
      new Response(
        JSON.stringify({
          schema: 1,
          channel: "dogfood",
          items: version
            ? [
                {
                  kind: "stage-release",
                  version,
                  commit: version,
                  publishedAt: "2026-09-09T00:00:00Z",
                  platforms: {
                    linux: {
                      url: `https://example.test/${version}`,
                      fallbackUrl: "https://example.test/fallback",
                    },
                  },
                },
              ]
            : [],
        }),
        { status },
      ),
    ),
  );
}

async function checkBoth() {
  await act(async () => {
    void first.check();
    void second.check();
  });
}
function button(slot: string, label: string) {
  return [
    ...dom.window.document.querySelectorAll<HTMLButtonElement>(
      `[data-consumer=${slot}] button`,
    ),
  ].find((node) => node.textContent === label);
}
function toastAction(index = 0) {
  const action = spies.info.mock.calls[index][1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action))
    throw new Error("Expected download action");
  return () => action.onClick({} as Parameters<typeof action.onClick>[0]);
}

test("one delayed attempt survives StrictMode/rerenders; auto result survives About and project remounts", async () => {
  await render({ strict: true, about: false });
  await advance(2000);
  await render({ strict: true });
  await advance(2999);
  expect(requests.length).toBe(0);
  await advance(1);
  expect(requests.length).toBe(1);
  expect(first.checking && second.checking).toBe(true);
  await checkBoth();
  expect(requests.length).toBe(1);
  expect(button("second", m.updates_status_checking())?.disabled).toBe(true);
  await answer(0);
  expect(first.update?.item.version).toBe("0.0.9");
  expect(second.update).toBe(first.update);
  expect(Boolean(button("second", m.updates_download()))).toBe(true);
  expect(spies.info.mock.calls.length).toBe(1);
  expect(dom.window.localStorage.getItem(LAST_CHECK)).toBe(String(now));
  expect(dom.window.localStorage.getItem(LAST_NOTIFIED)).toBe(first.update!.id);
  await render({ strict: true, about: false });
  await render({ strict: true, project: "two" });
  expect(second.update?.item.version).toBe("0.0.9");
  await advance(INTERVAL * 2);
  expect(requests.length).toBe(1);
});

test("concurrent manual calls share checking and feedback; auto never cancels manual", async () => {
  await render();
  dom.window.localStorage.setItem(LAST_CHECK, String(now));
  await checkBoth();
  expect(requests.length).toBe(1);
  expect(button("first", m.updates_status_checking())?.disabled).toBe(true);
  await advance(5000);
  expect(requests.length).toBe(1);
  expect(requests[0].signal?.aborted).toBe(false);
  await answer(0, null);
  expect(first.status).toBe("current");
  expect(spies.success.mock.calls.length).toBe(1);
  await checkBoth();
  expect(requests.length).toBe(2);
  await answer(1);
  expect(spies.info.mock.calls.length).toBe(1);
  expect(dom.window.localStorage.getItem(LAST_NOTIFIED)).toBeNull();
});

test("known build survives check/error; old toast uses latest build and is dismissed on empty result", async () => {
  await render();
  await checkBoth();
  await answer(0);
  const oldAction = toastAction();
  await checkBoth();
  expect(first.update?.item.version).toBe("0.0.9");
  expect(button("second", m.updates_download())?.disabled).toBe(false);
  const lastCheck = dom.window.localStorage.getItem(LAST_CHECK);
  await answer(1, null, 503);
  expect(first.status).toBe("error");
  expect(first.update?.item.version).toBe("0.0.9");
  expect(dom.window.localStorage.getItem(LAST_CHECK)).toBe(lastCheck);
  expect(spies.error.mock.calls.length).toBe(1);
  await render({ project: "two" });
  expect(second.update).toBe(first.update);
  await checkBoth();
  await answer(2, "0.0.10");
  await act(async () => oldAction());
  expect(urls).toEqual(["https://example.test/0.0.10"]);
  await checkBoth();
  await answer(3, null);
  expect(spies.dismiss.mock.calls.some(([id]) => id === 100)).toBe(true);
  expect(button("second", m.updates_download())).toBe(undefined);
  await act(async () => oldAction());
  expect(urls.length).toBe(1);
});

test("About and toast share platform URL/fallback/error/retry without clearing update", async () => {
  await render();
  await checkBoth();
  await answer(0);
  failOpen = (url) => !url.endsWith("fallback");
  await act(async () => {
    button("second", m.updates_download())!.click();
  });
  expect(urls).toEqual([
    "https://example.test/0.0.9",
    "https://example.test/fallback",
  ]);
  expect(spies.error.mock.calls.length).toBe(0);
  failOpen = () => true;
  await act(async () => toastAction()());
  expect(spies.error.mock.calls.length).toBe(1);
  failOpen = () => false;
  await act(async () => first.openUpdate());
  expect(urls.at(-1)).toBe("https://example.test/0.0.9");
  expect(second.update === null).toBe(false);
});

test("unknown version waits; build change clears state without descendant remounts and rejects late response", async () => {
  await render({ version: "" });
  expect(button("first", m.updates_status_check())?.disabled).toBe(true);
  await checkBoth();
  await advance(5000);
  expect(requests.length).toBe(0);
  await render();
  expect(mounts).toBe(2);
  await advance(5000);
  await answer(0);
  const oldAction = toastAction();
  await checkBoth();
  await render({ commit: "new-build" });
  expect(requests[1].signal?.aborted).toBe(true);
  expect(first.update).toBeNull();
  expect(first.status).toBe("idle");
  expect(mounts).toBe(2);
  const storage = dom.window.localStorage.getItem(LAST_CHECK);
  const count = spies.info.mock.calls.length;
  await answer(1, "0.0.10");
  await act(async () => oldAction());
  expect(first.update).toBeNull();
  expect(spies.info.mock.calls.length).toBe(count);
  expect(dom.window.localStorage.getItem(LAST_CHECK)).toBe(storage);
  expect(urls.length).toBe(0);
});

test("teardown aborts request and suppresses late response effects", async () => {
  await render();
  await advance(5000);
  await act(async () => root.unmount());
  expect(requests[0].signal?.aborted).toBe(true);
  await answer(0);
  expect(spies.info.mock.calls.length).toBe(0);
  expect(dom.window.localStorage.getItem(LAST_CHECK)).toBeNull();
  expect(dom.window.localStorage.getItem(LAST_NOTIFIED)).toBeNull();
});

test("automatic interval and silent dedup preserve manual feedback", async () => {
  dom.window.localStorage.setItem(LAST_CHECK, String(now));
  await render();
  await advance(5000);
  expect(requests.length).toBe(0);
  dom.window.localStorage.setItem(
    LAST_NOTIFIED,
    "stage-release:0.0.9:0.0.9::linux",
  );
  await advance(INTERVAL);
  await act(async () => {
    void first.check({ silent: true });
  });
  await answer(0);
  expect(first.update === null).toBe(false);
  expect(spies.info.mock.calls.length).toBe(0);
  await checkBoth();
  await answer(1);
  expect(spies.info.mock.calls.length).toBe(1);
});

test("silent empty/error stay quiet; storage failure does not block checking or download", async () => {
  await render();
  await advance(5000);
  await answer(0, null);
  expect(spies.success.mock.calls.length).toBe(0);
  await advance(INTERVAL);
  await act(async () => {
    void first.check({ silent: true });
  });
  await act(async () => requests[1].reject(new Error("offline")));
  expect(spies.error.mock.calls.length).toBe(0);
  const get = spyOn(dom.window.Storage.prototype, "getItem").mockImplementation(
    () => {
      throw new Error("storage denied");
    },
  );
  const set = spyOn(dom.window.Storage.prototype, "setItem").mockImplementation(
    () => {
      throw new Error("storage denied");
    },
  );
  try {
    await act(async () => {
      void first.check({ silent: true });
    });
    await answer(2);
    expect(first.update === null).toBe(false);
    await act(async () => first.openUpdate());
    expect(urls).toEqual(["https://example.test/0.0.9"]);
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

test("teardown suppresses late request rejection and download fallback effects", async () => {
  await render();
  await checkBoth();
  await answer(0);
  let rejectOpen!: (error: Error) => void;
  mockNativeIpc(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectOpen = reject;
      }),
  );
  let download!: Promise<void>;
  await act(async () => {
    download = first.openUpdate();
  });
  await checkBoth();
  await act(async () => root.unmount());
  const lastCheck = dom.window.localStorage.getItem(LAST_CHECK);
  await act(async () => {
    requests[1].reject(new Error("late network failure"));
    rejectOpen(new Error("late opener failure"));
    await download;
  });
  expect(spies.error.mock.calls.length).toBe(0);
  expect(dom.window.localStorage.getItem(LAST_CHECK)).toBe(lastCheck);
});
