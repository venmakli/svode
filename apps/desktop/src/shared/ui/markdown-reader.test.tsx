import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import {
  MarkdownReader,
  MarkdownReaderBoundary,
  MarkdownReaderLink,
  MarkdownReaderPlaintextFallback,
  type MarkdownReaderPolicy,
} from "./markdown-reader";

const fixtureRoot = new URL("./__fixtures__/markdown-reader/", import.meta.url);

const blockedPolicy: MarkdownReaderPolicy = {};

test("Reader renders GFM tables, task lists, and code fences from AGENTS.md", () => {
  const content = readFixture("AGENTS.md");
  const markup = renderToStaticMarkup(
    <MarkdownReader content={content} policy={blockedPolicy} />,
  );

  expect(markup.includes("Workspace instructions")).toBe(true);
  expect(markup.includes("<table")).toBe(true);
  expect(markup.includes('type="checkbox"')).toBe(true);
  expect(markup.includes("const owner")).toBe(true);
  expect(markup.includes('data-markdown-reader="true"')).toBe(true);
  expect(markup.includes("contenteditable")).toBe(false);
});

test("Reader applies explicit link policy and blocks HTML and all automatic media", () => {
  const content = readFixture("CLAUDE.md");
  const policy: MarkdownReaderPolicy = {
    renderLink: (href, children) =>
      href === "https://docs.example.com/guide" ? (
        <MarkdownReaderLink target="approved:docs" onOpen={() => undefined}>
          {children}
        </MarkdownReaderLink>
      ) : null,
  };
  const markup = renderToStaticMarkup(
    <MarkdownReader content={content} policy={policy} />,
  );

  expect(markup.includes('data-markdown-reader-link="approved:docs"')).toBe(
    true,
  );
  expect(markup.includes("data-markdown-reader-blocked-link")).toBe(true);
  expect(markup.includes("<img")).toBe(false);
  expect(markup.includes("tracker.png")).toBe(false);
  expect(markup.includes("<script>")).toBe(false);
  expect(markup.includes("window.readerExecuted = true")).toBe(true);
  expect(markup.includes("javascript:alert")).toBe(false);
});

test("Reader gives the policy link URLs as written and inline code to wrap", () => {
  const hrefs: string[] = [];
  const codes: string[] = [];
  const content = [
    "[a](/abs/a.md) [b](file:///abs/b%20c.md#L3) [c](src/main.rs:42)",
    "[d](~/notes.txt) [e](./x/y.rs#L10-L20) [f](../up.md:3:7)",
    "[g](main.rs:10-20) [h](<a b.md>) [i](javascript:alert(1))",
    "",
    "`~/a/b` and `plain`",
  ].join("\n");
  const markup = renderToStaticMarkup(
    <MarkdownReader
      content={content}
      policy={{
        renderLink: (href) => {
          hrefs.push(href);
          return null;
        },
        renderInlineCode: (code, element) => {
          codes.push(code);
          return code === "plain" ? null : <mark>{element}</mark>;
        },
      }}
    />,
  );

  expect(hrefs).toEqual([
    "/abs/a.md",
    "file:///abs/b%20c.md#L3",
    "src/main.rs:42",
    "~/notes.txt",
    "./x/y.rs#L10-L20",
    "../up.md:3:7",
    "main.rs:10-20",
    "a%20b.md",
    "javascript:alert(1)",
  ]);
  expect(codes).toEqual(["~/a/b", "plain"]);
  expect(markup.includes("javascript:")).toBe(false);
  expect(markup.includes("href=")).toBe(false);
  expect(
    markup.includes(
      '<mark><code class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm" data-streamdown="inline-code">~/a/b</code></mark>',
    ),
  ).toBe(true);
  expect(
    markup.includes(
      '<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-sm" data-streamdown="inline-code">plain</code>',
    ),
  ).toBe(true);
});

test("Reader receives a frontmatter-free SKILL.md body and preserves unknown fences as escaped text", () => {
  const fixture = splitFixtureFrontmatter(readFixture("SKILL.md"));
  const markup = renderToStaticMarkup(
    <MarkdownReader content={fixture.body} policy={blockedPolicy} />,
  );

  expect(fixture.frontmatter.includes("name: fixture-skill")).toBe(true);
  expect(markup.includes("name: fixture-skill")).toBe(false);
  expect(markup.includes("Fixture skill")).toBe(true);
  expect(markup.includes("unknown-language")).toBe(true);
  expect(markup.includes("&lt;script&gt;plaintext only&lt;/script&gt;")).toBe(
    true,
  );
});

test("Reader stays readable for malformed bounded content and plaintext fallback escapes HTML", () => {
  const malformed = `# Large fixture\n\n\`\`\`text\n${"bounded ".repeat(8_192)}`;
  const markup = renderToStaticMarkup(
    <MarkdownReader content={malformed} policy={blockedPolicy} />,
  );
  const fallback = renderToStaticMarkup(
    <MarkdownReaderPlaintextFallback
      content={'<img src=x onerror="write()">'}
    />,
  );

  expect(markup.includes("Large fixture")).toBe(true);
  expect(markup.includes("bounded")).toBe(true);
  expect(fallback.includes("<img")).toBe(false);
  expect(
    fallback.includes("&lt;img src=x onerror=&quot;write()&quot;&gt;"),
  ).toBe(true);
  expect(fallback.includes("[overflow-wrap:anywhere]")).toBe(true);
});

test("Reader typesets only $$ formulas, inline and as a block, and keeps single dollars as text", () => {
  const markup = renderToStaticMarkup(
    <MarkdownReader
      content={
        "Energy $$E = mc^2$$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nIt costs $5 и $10 together."
      }
      policy={blockedPolicy}
    />,
  );
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  const document = dom.window.document;

  const formulas = Array.from(document.querySelectorAll(".katex"));
  expect(formulas.length).toBe(2);
  expect(
    formulas.map(
      (formula) =>
        formula.querySelector('annotation[encoding="application/x-tex"]')
          ?.textContent,
    ),
  ).toEqual(["E = mc^2", "\\int_0^1 x\\,dx"]);
  expect(document.querySelectorAll(".katex-display").length).toBe(1);
  expect(formulas[0]?.closest(".katex-display")).toBeNull();
  const prices = Array.from(document.querySelectorAll("p")).find((paragraph) =>
    paragraph.textContent?.includes("It costs"),
  );
  expect(prices?.textContent).toBe("It costs $5 и $10 together.");
  expect(prices?.querySelector(".katex")).toBeNull();
  dom.window.close();
});

test("Reader shows the source of a formula KaTeX cannot typeset", () => {
  const markup = renderToStaticMarkup(
    <MarkdownReader
      content={"Broken $$\\frac{1}{$$ formula."}
      policy={blockedPolicy}
    />,
  );
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  const errors = Array.from(
    dom.window.document.querySelectorAll(".katex-error"),
  );

  expect(errors.map((error) => error.textContent)).toEqual(["\\frac{1}{"]);
  expect(errors.every((error) => error.getAttribute("title"))).toBe(true);
  dom.window.close();
});

test("Reader contains inline content and makes code and table overflow regions keyboard reachable", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const longInline = `command-${"segment".repeat(80)}`;

  try {
    await act(async () => {
      root.render(
        <MarkdownReader
          content={`Inline \`${longInline}\`\n\n\`\`\`ts\nconst value = "${longInline}";\n\`\`\`\n\n\`\`\`unknown-language\n${longInline}\n\`\`\`\n\n| Key | Value |\n| --- | --- |\n| command | ${longInline} |`}
          policy={blockedPolicy}
        />,
      );
    });

    const reader = dom.window.document.querySelector<HTMLElement>(
      "[data-markdown-reader]",
    )!;
    expect(reader.className.includes("max-w-full")).toBe(true);
    expect(
      reader.querySelector('[data-streamdown="inline-code"]')?.textContent,
    ).toBe(longInline);

    const wideRegions = Array.from(
      reader.querySelectorAll<HTMLElement>("[data-markdown-reader-wide-block]"),
    );
    expect(wideRegions.length).toBe(3);
    expect(wideRegions.every((region) => region.tabIndex === 0)).toBe(true);
    expect(
      wideRegions.filter(
        (region) => region.dataset.streamdown === "code-block-body",
      ).length,
    ).toBe(2);
    expect(
      wideRegions.some(
        (region) => region.querySelector('[data-streamdown="table"]') !== null,
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("Reader link activation uses the supplied callback without navigation or network reads", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const opened: string[] = [];
  let fetchCount = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCount += 1;
    return Promise.reject(new Error("Reader must not fetch"));
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <MarkdownReader
          content={readFixture("CLAUDE.md")}
          policy={{
            renderLink: (href, children) =>
              href.startsWith("https://docs.example.com/") ? (
                <MarkdownReaderLink
                  target={href}
                  onOpen={() => opened.push(href)}
                >
                  {children}
                </MarkdownReaderLink>
              ) : null,
          }}
        />,
      );
    });

    const link = dom.window.document.querySelector<HTMLElement>(
      "[data-markdown-reader-link]",
    )!;
    expect(link.tagName).toBe("BUTTON");
    expect(dom.window.document.querySelector("a[href]")).toBeNull();
    expect(dom.window.document.querySelector("img")).toBeNull();

    await act(async () => {
      link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    expect(opened).toEqual(["https://docs.example.com/guide"]);
    expect(fetchCount).toBe(0);
    expect(dom.window.location.href).toBe("http://localhost/");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    restoreGlobals();
    dom.window.close();
  }
});

test("Reader boundary falls back to escaped plaintext after a renderer error", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    await act(async () => {
      root.render(
        <MarkdownReaderBoundary content="<script>write()</script>">
          <ThrowingRenderer />
        </MarkdownReaderBoundary>,
      );
    });

    const fallback = dom.window.document.querySelector(
      "[data-markdown-reader-plaintext]",
    )!;
    expect(fallback.textContent).toBe("<script>write()</script>");
    expect(fallback.querySelector("script")).toBeNull();
  } finally {
    console.error = originalConsoleError;
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function ThrowingRenderer(): ReactNode {
  throw new Error("Fixture renderer failed");
}

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixtureRoot), "utf8");
}

function splitFixtureFrontmatter(content: string): {
  body: string;
  frontmatter: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) return { body: content, frontmatter: "" };
  return { body: match[2] ?? "", frontmatter: match[1] ?? "" };
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
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
