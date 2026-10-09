import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import * as m from "@/paraglide/messages.js";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_PEEK_TOP_BAR_TEST !== "1") {
  test("peek top bar layout and labels", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PEEK_TOP_BAR_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  // Radix picks its layout effect when first loaded, so the DOM comes first.
  const boot = await createTestDom();
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { PeekCloseButton, PeekExpandButton, PeekIdentity, PeekTopBar } =
    await import("./peek-top-bar");
  await boot.dispose();

  function precedes(left: Element, right: Element) {
    return Boolean(
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }

  test("the bar orders its slots as R2: identity ⓘ ⋯ on the left, then tools, Changes, Open with, Expand and ×", async () => {
    const dom = await createTestDom();
    try {
      await dom.render(
        <TooltipProvider>
          <PeekTopBar
            identity={<PeekIdentity icon="📄" name="Roadmap" />}
            info={<button data-slot-name="info" />}
            menu={<button data-slot-name="menu" />}
            viewTools={<button data-slot-name="tools" />}
            changes={<button data-slot-name="changes" />}
            openWith={<button data-slot-name="open-with" />}
            onExpand={() => {}}
            onClose={() => {}}
          />
        </TooltipProvider>,
      );
      const bar = dom.document.querySelector("[data-peek-top-bar]")!;
      const slots = [
        bar.querySelector("[data-peek-identity]")!,
        bar.querySelector('[data-slot-name="info"]')!,
        bar.querySelector('[data-slot-name="menu"]')!,
        bar.querySelector('[data-slot-name="tools"]')!,
        bar.querySelector('[data-slot-name="changes"]')!,
        bar.querySelector('[data-slot-name="open-with"]')!,
        bar.querySelector(`[aria-label="${m.peek_expand()}"]`)!,
        bar.querySelector(`[aria-label="${m.peek_close()}"]`)!,
      ];
      expect(slots.every(Boolean)).toBe(true);
      for (let index = 1; index < slots.length; index += 1)
        expect(precedes(slots[index - 1], slots[index])).toBe(true);
      expect(bar.querySelector("[data-peek-identity]")?.textContent).toBe(
        "📄Roadmap",
      );
      // Identity is not a control.
      expect(bar.querySelector("[data-peek-identity] button, a")).toBeNull();
      // Expand is icon-only: its name lives in the tooltip and aria-label.
      const expand = slots[6] as HTMLButtonElement;
      expect(expand.textContent).toBe("");
      expect(bar.textContent?.includes("Full page")).toBe(false);
    } finally {
      await dom.dispose();
    }
  });

  test("absent slots leave no controls and Expand is optional", async () => {
    const dom = await createTestDom();
    let closed = 0;
    try {
      await dom.render(
        <TooltipProvider>
          <PeekTopBar onClose={() => (closed += 1)} />
        </TooltipProvider>,
      );
      const buttons = [...dom.document.querySelectorAll("button")];
      expect(
        buttons.map((button) => button.getAttribute("aria-label")),
      ).toEqual([m.peek_close()]);
      await act(async () => buttons[0].click());
      expect(closed).toBe(1);
    } finally {
      await dom.dispose();
    }
  });

  for (const [language, expand, close] of [
    ["en", "Expand", "Close"],
    ["ru", "Развернуть", "Закрыть"],
  ] as const) {
    test(`Expand and × are named "${expand}" and "${close}" in the tooltip and for screen readers (${language})`, async () => {
      const locale = getLocale();
      setLocale(language, { reload: false });
      const dom = await createTestDom();
      try {
        await dom.render(
          <TooltipProvider>
            <PeekExpandButton onClick={() => {}} />
            <PeekCloseButton onClick={() => {}} />
          </TooltipProvider>,
        );
        for (const label of [expand, close]) {
          const button = dom.document.querySelector<HTMLButtonElement>(
            `button[aria-label="${label}"]`,
          )!;
          expect(Boolean(button)).toBe(true);
          await act(async () => {
            button.focus();
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
          expect(
            dom.document.querySelector('[role="tooltip"]')?.textContent,
          ).toBe(label);
          await act(async () => button.blur());
        }
      } finally {
        await dom.dispose();
        setLocale(locale, { reload: false });
      }
    });
  }

  test("a pending close guard keeps × disabled with a spinner", async () => {
    const dom = await createTestDom();
    try {
      await dom.render(
        <TooltipProvider>
          <PeekTopBar onClose={() => {}} closePending />
        </TooltipProvider>,
      );
      const close = dom.document.querySelector<HTMLButtonElement>(
        `button[aria-label="${m.peek_close()}"]`,
      )!;
      expect(close.disabled).toBe(true);
      expect(Boolean(close.querySelector(".animate-spin"))).toBe(true);
    } finally {
      await dom.dispose();
    }
  });
}
