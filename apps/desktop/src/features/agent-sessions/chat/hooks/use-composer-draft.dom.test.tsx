import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

if (process.env.SVODE_COMPOSER_DRAFT_DOM !== "1") {
  test("composer draft DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_COMPOSER_DRAFT_DOM: "1" },
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const [key, value] of Object.entries({
    IS_REACT_ACT_ENVIRONMENT: true,
    document: dom.window.document,
    navigator: dom.window.navigator,
    window: dom.window,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const { act, useLayoutEffect, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useComposerDraft } = await import("./use-composer-draft");
  const { appendComposerDraftText, readComposerDraft, writeComposerDraft } = await import(
    "../model/composer"
  );

  const KEY = "new:/project";
  type Update = ReturnType<typeof useComposerDraft>[1];
  interface Api {
    update: Update;
    touch: () => void;
  }

  /** The draft's hook with another state of the same component beside it. */
  function Draft({ apiRef }: { apiRef: { current: Api | null } }) {
    const [, update] = useComposerDraft(KEY);
    const [, setOther] = useState(0);
    useLayoutEffect(() => {
      apiRef.current = { update, touch: () => setOther((value) => value + 1) };
    });
    return null;
  }

  function Host({
    apiRef,
    hideRef,
  }: {
    apiRef: { current: Api | null };
    hideRef: { current: (() => void) | null };
  }) {
    const [shown, setShown] = useState(true);
    useLayoutEffect(() => {
      hideRef.current = () => setShown(false);
    });
    return shown ? <Draft apiRef={apiRef} /> : null;
  }

  async function mounted() {
    const root = createRoot(document.createElement("div"));
    const apiRef: { current: Api | null } = { current: null };
    const hideRef: { current: (() => void) | null } = { current: null };
    await act(async () => root.render(<Host apiRef={apiRef} hideRef={hideRef} />));
    return {
      api: apiRef.current!,
      hide: () => hideRef.current!(),
      unmount: () => act(async () => root.unmount()),
    };
  }

  test("a change stays stored when its surface goes in the same batch as other pending work", async () => {
    window.sessionStorage.clear();
    writeComposerDraft(KEY, {
      parts: [{ type: "text", text: "Hello" }],
      sending: { previousTurnId: null },
    });
    const { api, hide, unmount } = await mounted();
    // A started session replaces the draft while the draft's session
    // still updates the component (DF-214).
    await act(async () => {
      api.touch();
      api.update(() => ({ parts: [] }));
      hide();
    });
    expect(readComposerDraft(KEY)).toBeNull();
    await unmount();
  });

  test("changes made together build on each other", async () => {
    window.sessionStorage.clear();
    const { api, unmount } = await mounted();
    await act(async () => {
      api.update({ parts: [{ type: "text", text: "Hi" }] });
      api.update((draft) => ({ ...draft, agent: "codex" }));
    });
    expect(readComposerDraft(KEY)).toEqual({
      parts: [{ type: "text", text: "Hi" }],
      agent: "codex",
    });
    await unmount();
  });

  test("a change builds on text appended to the stored draft from outside", async () => {
    window.sessionStorage.clear();
    const { api, unmount } = await mounted();
    await act(async () => api.update({ parts: [{ type: "text", text: "Hi" }] }));
    await act(async () => appendComposerDraftText(KEY, () => " there"));
    await act(async () => api.update((draft) => ({ ...draft, agent: "codex" })));
    expect(readComposerDraft(KEY)).toEqual({
      parts: [{ type: "text", text: "Hi there" }],
      agent: "codex",
    });
    await unmount();
  });
}
