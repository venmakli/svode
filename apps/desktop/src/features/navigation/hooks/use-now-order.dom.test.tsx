import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationResolvedItem,
} from "../model/keys";
import {
  createNavigationStore,
  type NavigationStateApi,
} from "../model/navigation-store";
import {
  continuesStayingNowRows,
  hideNowRow,
  nowOrderOf,
  type NowOrderRow,
} from "../model/now-order";
import { NavigationStoreProvider } from "../ui/navigation-store-provider";
import { useNowOrder } from "./use-now-order";

test("rows read in part keep the hidden rows and the order of a project (DF-207 R4, DF-206 R6)", async () => {
  const dom = await createTestDom();
  const project = "/projects/partial-read";
  const shown: string[][] = [];
  function Now({ rows, complete }: { rows: NowOrderRow[]; complete: boolean }) {
    const order = useNowOrder(project, rows, complete);
    shown.push(order.map((index) => rows[index].ids[0]));
    return null;
  }
  const session = (id: string): NowOrderRow => ({
    ids: [id],
    signs: [true, false, false, false],
  });
  try {
    await dom.render(
      <Now rows={[session("late"), session("hidden")]} complete />,
    );
    await dom.render(
      <Now
        rows={[session("late"), session("hidden"), session("early")]}
        complete
      />,
    );
    hideNowRow(project, session("hidden"));
    // Before the sessions are read only the kept rows are known.
    await dom.render(<Now rows={[]} complete={false} />);
    await dom.render(
      <Now
        rows={[session("early"), session("hidden"), session("late")]}
        complete
      />,
    );
    expect(shown.at(-1)).toEqual(["late", "early"]);
  } finally {
    await dom.dispose();
  }
});

function keepingStore(project: string, fail: boolean) {
  const keeps: string[] = [];
  let kept: NavigationResolvedItem[] = [];
  const state = async () => ({ pinned: [], kept: [...kept] });
  const api: NavigationStateApi = {
    read: state,
    pin: state,
    keep: async (_projectPath, item, before) => {
      keeps.push(
        `${item.title} before ${before ? navigationKeyId(before) : "end"}`,
      );
      if (fail) throw new Error("disk full");
      const at = before
        ? kept.findIndex(
            (current) =>
              navigationKeyId(current.key) === navigationKeyId(before),
          )
        : -1;
      kept =
        at < 0
          ? [...kept, item]
          : [...kept.slice(0, at), item, ...kept.slice(at)];
      return state();
    },
    unpin: state,
    unkeep: state,
    forget: state,
    retitle: state,
  };
  const store = createNavigationStore(api);
  store.getState().setProject(project);
  return { store, keeps };
}

test("an ended row is kept once in its place, whichever surface shows it (DF-210 R1)", async () => {
  const dom = await createTestDom();
  const project = "/projects/ended";
  const { store, keeps } = keepingStore(project, false);
  const item: NavigationItem = {
    key: { kind: "session", sessionId: "codex:a" },
    title: "codex:a",
  };
  const id = navigationKeyId(item.key);
  const below: NavigationItem = {
    key: { kind: "page", path: "below.md" },
    title: "below.md",
  };
  function Now({ rows }: { rows: NowOrderRow[] }) {
    useNowOrder(project, rows, true);
    return null;
  }
  const surfaces = (rows: NowOrderRow[]) => (
    <NavigationStoreProvider store={store}>
      <Now rows={rows} />
      <Now rows={rows} />
    </NavigationStoreProvider>
  );
  try {
    await act(() => store.getState().keep(below));
    await dom.render(
      surfaces([
        { ids: [id], stays: true },
        { ids: [navigationKeyId(below.key)] },
      ]),
    );
    await dom.render(
      surfaces([
        { ids: [navigationKeyId(below.key)] },
        { ids: [id], stays: true, keep: item },
      ]),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(keeps).toEqual([
      `below.md before end`,
      `codex:a before ${navigationKeyId(below.key)}`,
    ]);
    expect(store.getState().kept.map((current) => current.title)).toEqual([
      "codex:a",
      "below.md",
    ]);
  } finally {
    await dom.dispose();
  }
});

test("an ended row whose keep fails leaves Now", async () => {
  const dom = await createTestDom();
  const project = "/projects/ended-failed";
  const { store, keeps } = keepingStore(project, true);
  const item: NavigationItem = {
    key: { kind: "session", sessionId: "codex:a" },
    title: "codex:a",
  };
  const id = navigationKeyId(item.key);
  const shown: number[] = [];
  // As Now composes it: the ended row shows while it continues a staying one.
  function Now({ ended }: { ended: boolean }) {
    const rows: NowOrderRow[] = ended
      ? continuesStayingNowRows(nowOrderOf(project), [{ ids: [id] }])[0]
        ? [{ ids: [id], stays: true, keep: item }]
        : []
      : [{ ids: [id], stays: true }];
    shown.push(useNowOrder(project, rows, true).length);
    return null;
  }
  try {
    await dom.render(
      <NavigationStoreProvider store={store}>
        <Now ended={false} />
      </NavigationStoreProvider>,
    );
    await dom.render(
      <NavigationStoreProvider store={store}>
        <Now ended />
      </NavigationStoreProvider>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(keeps).toEqual(["codex:a before end"]);
    expect(nowOrderOf(project)).toEqual([]);
    expect(shown.at(-1)).toBe(0);
  } finally {
    await dom.dispose();
  }
});
