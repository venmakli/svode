import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import * as m from "@/paraglide/messages.js";
import {
  getLocale as getParaglideLocale,
  setLocale as setParaglideLocale,
} from "@/paraglide/runtime.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { AppLocaleProvider, useAppLocale } from "./use-app-locale";

test("bootstraps before localized UI and switches both directions without remount", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const bootstrap = deferred<AppSettingsResponse>();
  const localeMutations: string[] = [];
  mockNativeIpc((command, args) => {
    if (command === "get_app_settings") return bootstrap.promise;
    if (command === "set_app_locale") {
      const language = (args as { locale: string }).locale;
      localeMutations.push(language);
      return language;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);
  let mountCount = 0;

  try {
    await act(async () => {
      root.render(
        <AppLocaleProvider fallback={<span data-bootstrap>Loading</span>}>
          <LocaleHarness onMount={() => (mountCount += 1)} />
        </AppLocaleProvider>,
      );
      await nextTurn();
    });
    expect(dom.window.document.querySelector("[data-bootstrap]") === null).toBe(
      false,
    );
    expect(dom.window.document.querySelector("[data-locale]")).toBeNull();

    await act(async () => {
      bootstrap.resolve(appSettings("ru"));
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("ru");
    expect(textOf(dom, "[data-localized-label]")).toBe("Язык");
    expect(dom.window.document.documentElement.lang).toBe("ru");
    expect(dom.window.document.documentElement.dir).toBe("ltr");
    expect(mountCount).toBe(1);

    await clickAndFlush(dom, "[data-change-locale]");
    expect(textOf(dom, "[data-locale]")).toBe("en");
    expect(textOf(dom, "[data-localized-label]")).toBe("Language");
    expect(localeMutations).toEqual(["en"]);
    expect(mountCount).toBe(1);

    await clickAndFlush(dom, "[data-change-locale]");
    expect(textOf(dom, "[data-locale]")).toBe("ru");
    expect(textOf(dom, "[data-localized-label]")).toBe("Язык");
    expect(localeMutations).toEqual(["en", "ru"]);
    expect(mountCount).toBe(1);

    await clickAndFlush(dom, "[data-keep-locale]");
    expect(localeMutations).toEqual(["en", "ru"]);
    expect(mountCount).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("keeps the confirmed locale when persistence fails", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const mutation = deferred<string>();
  mockNativeIpc((command) => {
    if (command === "get_app_settings") return appSettings("en");
    if (command === "set_app_locale") return mutation.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppLocaleProvider fallback={<span>Loading</span>}>
          <LocaleHarness onMount={() => undefined} />
        </AppLocaleProvider>,
      );
      await nextTurn();
      await nextTurn();
    });

    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-change-locale]")!
        .click();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("en");
    expect(textOf(dom, "[data-pending]")).toBe("pending");

    await act(async () => {
      mutation.reject(new Error("write failed"));
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("en");
    expect(textOf(dom, "[data-pending]")).toBe("ready");
    expect(textOf(dom, "[data-error-count]")).toBe("1");
    expect(dom.window.document.documentElement.lang).toBe("en");
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function LocaleHarness({ onMount }: { onMount: () => void }) {
  const { locale, localePending, setLocale } = useAppLocale();
  const [instance] = useState(() => {
    onMount();
    return "same-instance";
  });
  const [errorCount, setErrorCount] = useState(0);

  return (
    <>
      <span data-locale>{locale}</span>
      <span data-pending>{localePending ? "pending" : "ready"}</span>
      <span data-instance>{instance}</span>
      <span data-error-count>{errorCount}</span>
      <LocalizedLabel />
      <button
        type="button"
        data-change-locale
        onClick={() => {
          void setLocale(locale === "en" ? "ru" : "en").catch(() => {
            setErrorCount((count) => count + 1);
          });
        }}
      />
      <button
        type="button"
        data-keep-locale
        onClick={() => void setLocale(locale)}
      />
    </>
  );
}

function LocalizedLabel() {
  return <span data-localized-label>{m.settings_language_label()}</span>;
}

interface AppSettingsResponse {
  agents?: {
    detected: unknown[];
  };
  appearance: {
    language: string;
    theme: string;
  };
  window: {
    height: number;
    width: number;
  };
}

function appSettings(language: string): AppSettingsResponse {
  return {
    appearance: { language, theme: "system" },
    window: { height: 800, width: 1200 },
  };
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html lang=en><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function clickAndFlush(dom: JSDOM, selector: string) {
  await act(async () => {
    dom.window.document.querySelector<HTMLButtonElement>(selector)!.click();
    await nextTurn();
    await nextTurn();
  });
}

function textOf(dom: JSDOM, selector: string) {
  return dom.window.document.querySelector(selector)?.textContent ?? "";
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
