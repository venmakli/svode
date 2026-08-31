import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TitleZone } from "./title-zone";

test("keeps title editing local until blur commits one rename intent", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const changes: string[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TitleZone
          title="Initial"
          icon={null}
          description=""
          hideDescription
          fallbackEmoji="📄"
          onTitleChange={(title) => changes.push(title)}
          onIconChange={() => undefined}
          onDescriptionChange={() => undefined}
          onBodyFocus={() => undefined}
        />,
      );
    });

    const input =
      dom.window.document.querySelector<HTMLInputElement>(
        'input[type="text"]',
      )!;
    await act(async () => {
      input.focus();
      setInputValue(input, "Renamed collection");
    });

    expect(dom.window.document.activeElement).toBe(input);
    expect(changes).toEqual([]);

    await act(async () => input.blur());
    expect(changes).toEqual(["Renamed collection"]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("canonical title update keeps Enter focus in the description", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const renderTitle = (title: string) =>
    root.render(
      <TitleZone
        title={title}
        icon={null}
        description=""
        fallbackEmoji="📄"
        onTitleChange={() => undefined}
        onIconChange={() => undefined}
        onDescriptionChange={() => undefined}
        onBodyFocus={() => undefined}
      />,
    );

  try {
    await act(async () => renderTitle("Initial"));
    const input =
      dom.window.document.querySelector<HTMLInputElement>(
        'input[type="text"]',
      )!;

    await act(async () => {
      input.focus();
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
      await new Promise((resolve) =>
        dom.window.requestAnimationFrame(() => resolve(undefined)),
      );
    });
    const description =
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(dom.window.document.activeElement).toBe(description);

    await act(async () => renderTitle("Renamed"));
    expect(dom.window.document.querySelector("textarea")).toBe(description);
    expect(dom.window.document.activeElement).toBe(description);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("read-only identity keeps its draft visible without emitting mutations", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const changes: string[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TitleZone
          title="Visible title"
          icon={null}
          description="Visible description"
          readOnly
          fallbackEmoji="📄"
          onTitleChange={(value) => changes.push(`title:${value}`)}
          onIconChange={(value) => changes.push(`icon:${value}`)}
          onDescriptionChange={(value) => changes.push(`description:${value}`)}
          onBodyFocus={() => changes.push("body")}
        />,
      );
    });

    const input = dom.window.document.querySelector<HTMLInputElement>("input")!;
    const description =
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(input.readOnly).toBe(true);
    expect(description.readOnly).toBe(true);
    expect(
      dom.window.document.querySelector<HTMLButtonElement>(
        'button[aria-label="Visible title"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      setInputValue(input, "Blocked rename");
      input.blur();
      description.dispatchEvent(
        new dom.window.Event("input", { bubbles: true }),
      );
    });
    expect(changes).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    input.ownerDocument.defaultView!.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new input.ownerDocument.defaultView!.Event("input", {
      bubbles: true,
    }),
  );
  const propertyChange = new input.ownerDocument.defaultView!.Event(
    "propertychange",
    { bubbles: true },
  );
  Object.defineProperty(propertyChange, "propertyName", { value: "value" });
  input.dispatchEvent(propertyChange);
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
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
