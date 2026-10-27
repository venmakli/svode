import { expect, test } from "bun:test";
import { navigationKeyId, type NavigationItem } from "./keys";
import {
  arrangeNowOrder,
  nowKeepPlace,
  nowOrderOf,
  recordNowOrder,
  type NowOrderRow,
} from "./now-order";

const row = (id: string, extra: Partial<NowOrderRow> = {}): NowOrderRow => ({
  ids: [id],
  ...extra,
});

/** Shows `rows` after `previous` and returns the shown ids. */
function show(previous: readonly NowOrderRow[], rows: readonly NowOrderRow[]) {
  const shown = arrangeNowOrder(previous, rows).map((index) => rows[index]);
  return { shown, ids: shown.map((entry) => entry.ids[0]) };
}

test("the first order is the order rows are given in", () => {
  expect(
    show([], [row("a"), row("b"), row("t", { temporary: true })]).ids,
  ).toEqual(["a", "b", "t"]);
});

test("a shown row keeps its place whatever order the rows come in", () => {
  const first = show([], [row("a"), row("b"), row("c")]);
  expect(show(first.shown, [row("c"), row("b"), row("a")]).ids).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("a row is the same row by any id it shares, then by a link", () => {
  const first = show(
    [],
    [row("a"), row("pending", { links: ["pty"] }), row("c")],
  );
  // A kept key joins the row; a pending session continues as canonical.
  const next = show(first.shown, [
    row("c"),
    { ids: ["canonical"], links: ["pty"] },
    { ids: ["kept-a", "a"] },
  ]);
  expect(next.ids).toEqual(["kept-a", "canonical", "c"]);
  // A row that shares an id wins over one that only shares a link.
  expect(
    show(next.shown, [
      { ids: ["other"], links: ["pty"] },
      { ids: ["canonical"] },
    ]).ids,
  ).toEqual(["canonical", "other"]);
});

test("new rows come last, before a temporary row that is last", () => {
  const first = show([], [row("a"), row("t", { temporary: true })]);
  const next = show(first.shown, [
    row("n"),
    row("a"),
    row("t", { temporary: true }),
  ]);
  expect(next.ids).toEqual(["a", "n", "t"]);
  // A temporary row that took the place of an earlier row keeps it.
  const kept = show(next.shown, [
    row("a", { temporary: true }),
    row("n"),
    row("t"),
    row("m"),
  ]);
  expect(kept.ids).toEqual(["a", "n", "t", "m"]);
  // A new temporary row is last.
  expect(
    show(kept.shown, [row("x", { temporary: true }), row("a"), row("n")]).ids,
  ).toEqual(["a", "n", "x"]);
});

test("a row that leaves does not move the others", () => {
  const first = show([], [row("a"), row("b"), row("c"), row("d")]);
  expect(show(first.shown, [row("d"), row("b"), row("a")]).ids).toEqual([
    "a",
    "b",
    "d",
  ]);
});

test("the order of a project outlives its surfaces in the window", () => {
  const project = "/projects/outlives";
  const rows = [row("a"), row("b")];
  recordNowOrder(project, show(nowOrderOf(project), rows).shown);
  recordNowOrder(project, show(nowOrderOf(project), [row("c"), ...rows]).shown);
  // A surface mounted again, or Home, reads the same order.
  expect(show(nowOrderOf(project), [row("c"), row("b"), row("a")]).ids).toEqual(
    ["a", "b", "c"],
  );
  expect(nowOrderOf("/projects/other")).toEqual([]);
});

test("a shown row is kept before the nearest kept item shown below it", () => {
  const project = "/projects/keep-place";
  const page = (path: string): NavigationItem => ({
    key: { kind: "page", path },
    title: path,
  });
  const session: NavigationItem = {
    key: { kind: "session", sessionId: "codex:s" },
    title: "s",
  };
  const id = (item: NavigationItem) => navigationKeyId(item.key);
  recordNowOrder(project, [
    row(id(page("a.md"))),
    row(id(session)),
    row("unkept"),
    row(id(page("c.md"))),
    row(id(page("b.md"))),
  ]);
  const kept = [page("a.md"), page("b.md"), page("c.md")];
  expect(nowKeepPlace(project, session.key, kept)).toEqual(page("c.md").key);
  // Below every kept item, or not shown: last.
  expect(nowKeepPlace(project, page("b.md").key, kept)).toBeNull();
  expect(nowKeepPlace(project, page("new.md").key, kept)).toBeNull();
});
