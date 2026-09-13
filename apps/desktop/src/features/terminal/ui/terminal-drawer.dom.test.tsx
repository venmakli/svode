import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

// Exercise the real portal: static markup cannot detect a terminal remount on hide.
test("drawer keeps its terminal mounted across hide, reopen, and position changes", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    {
      url: "http://localhost/",
      pretendToBeVisual: true,
    },
  );
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { Sheet, SheetContent, SheetTitle } =
    await import("@/components/ui/sheet");
  const { useTerminalDrawerLayout } =
    await import("../hooks/use-terminal-drawer-layout");
  const root = createRoot(dom.window.document.getElementById("app")!);
  let mounts = 0;
  let disposals = 0;
  let dismissals = 0;
  function TerminalBuffer() {
    useEffect(() => {
      mounts += 1;
      return () => {
        disposals += 1;
      };
    }, []);
    return <textarea defaultValue="session output" />;
  }
  function Harness({ open }: { open: boolean }) {
    const { side, ratio, toggleSide, resizeHandlers } =
      useTerminalDrawerLayout();
    return (
      <Sheet
        open={open}
        modal={false}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) dismissals += 1;
        }}
      >
        <SheetContent
          forceMount
          side={side}
          inert={!open}
          aria-describedby={undefined}
        >
          <SheetTitle>Terminal</SheetTitle>
          <button onClick={toggleSide}>Move</button>
          <div
            data-resize
            data-ratio={ratio}
            tabIndex={0}
            {...resizeHandlers}
          />
          <TerminalBuffer />
        </SheetContent>
      </Sheet>
    );
  }
  try {
    await act(async () => root.render(<Harness open />));
    const content = () =>
      dom.window.document.querySelector('[data-slot="sheet-content"]')!;
    const resize = () =>
      dom.window.document.querySelector<HTMLElement>("[data-resize]")!;
    const buffer = dom.window.document.querySelector("textarea");
    expect(content().getAttribute("data-side")).toBe("right");
    await act(async () =>
      resize().dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
        }),
      ),
    );
    const width = resize().dataset.ratio;
    expect(Math.round(Number(width) * 100)).toBe(44);
    await act(async () => dom.window.document.querySelector("button")!.click());
    expect(content().getAttribute("data-side")).toBe("bottom");
    expect(Math.round(Number(resize().dataset.ratio) * 100)).toBe(38);
    await act(async () => root.render(<Harness open={false} />));
    expect(content().getAttribute("data-state")).toBe("closed");
    expect(content().hasAttribute("inert")).toBe(true);
    await act(async () => root.render(<Harness open />));
    await act(async () => dom.window.document.querySelector("button")!.click());
    expect(resize().dataset.ratio).toBe(width);
    expect(dom.window.document.querySelector("textarea")).toBe(buffer);
    expect(mounts).toBe(1);
    expect(disposals).toBe(0);
    await act(async () => {
      dom.window.document.body.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(dismissals).toBe(1);
    expect(disposals).toBe(0);
  } finally {
    await act(async () => root.unmount());
    // Radix restores focus on a timer after unmount.
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
