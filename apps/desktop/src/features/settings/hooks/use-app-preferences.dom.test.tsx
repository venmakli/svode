import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import * as m from "@/paraglide/messages.js";
import {
  getLocale as getParaglideLocale,
  setLocale as setParaglideLocale,
} from "@/paraglide/runtime.js";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import {
  AppPreferencesProvider,
  useAppLocale,
  useAppTheme,
} from "./use-app-preferences";

test("bootstraps before localized UI and switches both directions without remount", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const bootstrap = deferred<AppSettingsResponse>();
  const localeMutations: string[] = [];
  let settingsReadCount = 0;
  let committedLanguage = "ru";
  mockPreferencesIpc(
    (command, args) => {
      if (command === "get_app_preferences") {
        settingsReadCount += 1;
        return settingsReadCount === 1
          ? bootstrap.promise
          : appPreferences(committedLanguage);
      }
      if (command === "set_app_locale") {
        const language = (args as { locale: string }).locale;
        committedLanguage = language;
        localeMutations.push(language);
        return language;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);
  let mountCount = 0;

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span data-bootstrap>Loading</span>}>
          <LocaleHarness onMount={() => (mountCount += 1)} />
        </AppPreferencesProvider>,
      );
      await nextTurn();
    });
    expect(dom.window.document.querySelector("[data-bootstrap]") === null).toBe(
      false,
    );
    expect(dom.window.document.querySelector("[data-locale]")).toBeNull();

    await act(async () => {
      bootstrap.resolve(appPreferences("ru"));
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
    await act(async () => {
      root.unmount();
      await nextTurn();
    });
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
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences") return appPreferences("en");
      if (command === "set_app_locale") return mutation.promise;
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <LocaleHarness onMount={() => undefined} />
        </AppPreferencesProvider>,
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

test("commits a theme field, applies it without remount, and skips same-value writes", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  let backendTheme = "system";
  const mutations: string[] = [];
  let mountCount = 0;
  mockPreferencesIpc(
    (command, args) => {
      if (command === "get_app_preferences")
        return appPreferences("en", backendTheme);
      if (command === "set_app_theme") {
        backendTheme = (args as { theme: string }).theme;
        mutations.push(backendTheme);
        return backendTheme;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <ThemeHarness onMount={() => (mountCount += 1)} />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });

    await clickAndFlush(dom, "[data-change-theme]");
    expect(textOf(dom, "[data-theme]")).toBe("dark");
    expect(textOf(dom, "[data-theme-pending]")).toBe("ready");
    expect(dom.window.document.documentElement.classList.contains("dark")).toBe(
      true,
    );
    expect(mutations).toEqual(["dark"]);
    expect(mountCount).toBe(1);

    await clickAndFlush(dom, "[data-keep-theme]");
    expect(mutations).toEqual(["dark"]);
    expect(mountCount).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("keeps the confirmed theme while pending and after persistence failure", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const mutation = deferred<string>();
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences")
        return appPreferences("en", "light");
      if (command === "set_app_theme") return mutation.promise;
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <ThemeHarness />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });

    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-change-theme]")!
        .click();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("light");
    expect(textOf(dom, "[data-theme-pending]")).toBe("pending");
    expect(dom.window.document.documentElement.classList.contains("light")).toBe(
      true,
    );

    await act(async () => {
      mutation.reject(new Error("write failed"));
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("light");
    expect(textOf(dom, "[data-theme-pending]")).toBe("ready");
    expect(textOf(dom, "[data-theme-error-count]")).toBe("1");
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("gives windows the theme on load and change and leaves them to the OS before computing the system theme", async () => {
  const dom = createDom();
  const webView = installWebViewTheme(dom, false);
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  let backendTheme = "dark";
  const mutations: string[] = [];
  mockNativeIpc(
    (command, args) => {
      if (command === WINDOW_THEME_COMMAND) {
        webView.setWindowTheme(windowThemeArg(args));
        return null;
      }
      if (command === "get_app_preferences")
        return appPreferences("en", backendTheme);
      if (command === "set_app_theme") {
        backendTheme = (args as { theme: string }).theme;
        mutations.push(backendTheme);
        return backendTheme;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);
  const rootClasses = dom.window.document.documentElement.classList;

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span data-bootstrap>Loading</span>}>
          <ThemeHarness />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("dark");
    expect(webView.windowThemes).toEqual(["dark"]);
    expect(rootClasses.contains("dark")).toBe(true);

    await clickAndFlush(dom, "[data-change-theme]");
    expect(textOf(dom, "[data-theme]")).toBe("light");
    expect(webView.windowThemes).toEqual(["dark", "light"]);
    expect(rootClasses.contains("light")).toBe(true);

    await clickAndFlush(dom, "[data-change-theme]");
    expect(webView.windowThemes).toEqual(["dark", "light", "dark"]);
    expect(rootClasses.contains("dark")).toBe(true);

    const readsBeforeSystem = webView.reads.length;
    await clickAndFlush(dom, "[data-system-theme]");
    expect(textOf(dom, "[data-theme]")).toBe("system");
    expect(webView.windowThemes).toEqual(["dark", "light", "dark", null]);
    const systemReads = webView.reads.slice(readsBeforeSystem);
    expect(systemReads.length > 0).toBe(true);
    expect(systemReads.every((read) => read.windowTheme === null)).toBe(true);
    expect(rootClasses.contains("light")).toBe(true);
    expect(rootClasses.contains("dark")).toBe(false);

    await act(async () => {
      webView.setOsDark(true);
      await nextTurn();
    });
    expect(rootClasses.contains("dark")).toBe(true);
    expect(webView.windowThemes).toEqual(["dark", "light", "dark", null]);
    expect(mutations).toEqual(["light", "dark", "system"]);
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("reacts to OS appearance changes in system mode without writing", async () => {
  const dom = createDom();
  const mediaQuery = installSystemTheme(dom, false);
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const mutations: string[] = [];
  mockPreferencesIpc(
    (command, args) => {
      if (command === "get_app_preferences")
        return appPreferences("en", "system");
      if (command === "set_app_theme") {
        mutations.push((args as { theme: string }).theme);
        return (args as { theme: string }).theme;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <ThemeHarness />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("system");
    expect(dom.window.document.documentElement.classList.contains("light")).toBe(
      true,
    );

    await act(async () => {
      mediaQuery.setMatches(true);
      await nextTurn();
    });
    expect(dom.window.document.documentElement.classList.contains("dark")).toBe(
      true,
    );
    expect(mutations).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("recovers a valid legacy theme once and removes localStorage ownership", async () => {
  const dom = createDom();
  dom.window.localStorage.setItem("svode-theme", "dark");
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const mutations: string[] = [];
  mockPreferencesIpc(
    (command, args) => {
      if (command === "get_app_preferences")
        return appPreferences("en", "system", true);
      if (command === "set_app_theme") {
        const theme = (args as { theme: string }).theme;
        mutations.push(theme);
        return theme;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <ThemeHarness />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("dark");
    expect(mutations).toEqual(["dark"]);
    expect(dom.window.localStorage.getItem("svode-theme")).toBeNull();
    expect(dom.window.document.documentElement.classList.contains("dark")).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("canonical theme wins over and removes stale legacy localStorage", async () => {
  const dom = createDom();
  dom.window.localStorage.setItem("svode-theme", "dark");
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  let mutationCount = 0;
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences")
        return appPreferences("en", "light");
      if (command === "set_app_theme") {
        mutationCount += 1;
        return "dark";
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <ThemeHarness />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("light");
    expect(mutationCount).toBe(0);
    expect(dom.window.localStorage.getItem("svode-theme")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("allows concurrent theme and locale mutations without losing either field", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const themeMutation = deferred<string>();
  const localeMutation = deferred<string>();
  let backendTheme = "system";
  let backendLocale = "en";
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences")
        return appPreferences(backendLocale, backendTheme);
      if (command === "set_app_theme") {
        return themeMutation.promise.then((theme) => {
          backendTheme = theme;
          return theme;
        });
      }
      if (command === "set_app_locale") {
        return localeMutation.promise.then((locale) => {
          backendLocale = locale;
          return locale;
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <LocaleHarness onMount={() => undefined} />
          <ThemeHarness />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });

    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-change-theme]")!
        .click();
      dom.window.document
        .querySelector<HTMLButtonElement>("[data-change-locale]")!
        .click();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme-pending]")).toBe("pending");
    expect(textOf(dom, "[data-pending]")).toBe("pending");

    await act(async () => {
      themeMutation.resolve("dark");
      await nextTurn();
      await nextTurn();
      localeMutation.resolve("ru");
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-theme]")).toBe("dark");
    expect(textOf(dom, "[data-locale]")).toBe("ru");
    expect(textOf(dom, "[data-theme-pending]")).toBe("ready");
    expect(textOf(dom, "[data-pending]")).toBe("ready");
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("applies the latest invalidation read and deduplicates repeated delivery", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const staleRead = deferred<AppSettingsResponse>();
  let readCount = 0;
  let renderCount = 0;
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences") {
        readCount += 1;
        if (readCount === 1) return appPreferences("en");
        if (readCount === 2) return staleRead.promise;
        return appPreferences("ru", "dark");
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <LocaleHarness
            onMount={() => undefined}
            onRender={() => (renderCount += 1)}
          />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("en");

    await act(async () => {
      await emitNativeEvent("app-settings:preferences-changed");
      await nextTurn();
    });
    expect(readCount).toBe(2);

    await act(async () => {
      await emitNativeEvent("app-settings:preferences-changed");
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("ru");
    expect(textOf(dom, "[data-theme]")).toBe("dark");
    const renderCountAfterFreshRead = renderCount;

    await act(async () => {
      staleRead.resolve(appPreferences("en", "light"));
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("ru");
    expect(textOf(dom, "[data-theme]")).toBe("dark");
    expect(renderCount).toBe(renderCountAfterFreshRead);

    await act(async () => {
      await emitNativeEvent("app-settings:preferences-changed");
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("ru");
    expect(renderCount).toBe(renderCountAfterFreshRead);
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("reconciles a missed change on foreground and cleans up the focus listener", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  let backendLocale = "en";
  let readCount = 0;
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences") {
        readCount += 1;
        return appPreferences(backendLocale);
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <LocaleHarness onMount={() => undefined} />
        </AppPreferencesProvider>,
      );
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("en");

    backendLocale = "ru";
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await nextTurn();
      await nextTurn();
    });
    expect(textOf(dom, "[data-locale]")).toBe("ru");

    await act(async () => {
      root.unmount();
      await nextTurn();
    });
    const readsBeforeCleanupCheck = readCount;
    backendLocale = "en";
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await nextTurn();
    expect(readCount).toBe(readsBeforeCleanupCheck);
  } finally {
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("does not apply a late mutation result over a newer committed locale", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const originalLocale = getParaglideLocale();
  const mutation = deferred<string>();
  let backendLocale = "en";
  mockPreferencesIpc(
    (command) => {
      if (command === "get_app_preferences")
        return appPreferences(backendLocale);
      if (command === "set_app_locale") return mutation.promise;
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <AppPreferencesProvider fallback={<span>Loading</span>}>
          <LocaleHarness onMount={() => undefined} />
        </AppPreferencesProvider>,
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
    expect(textOf(dom, "[data-pending]")).toBe("pending");

    backendLocale = "en";
    await act(async () => {
      await emitNativeEvent("app-settings:preferences-changed");
      await nextTurn();
      mutation.resolve("ru");
      await nextTurn();
      await nextTurn();
    });

    expect(textOf(dom, "[data-locale]")).toBe("en");
    expect(textOf(dom, "[data-pending]")).toBe("ready");
    expect(dom.window.document.documentElement.lang).toBe("en");
  } finally {
    await act(async () => root.unmount());
    await setParaglideLocale(originalLocale, { reload: false });
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function LocaleHarness({
  onMount,
  onRender,
}: {
  onMount: () => void;
  onRender?: () => void;
}) {
  onRender?.();
  const { locale, localePending, setLocale } = useAppLocale();
  const { theme } = useAppTheme();
  const [instance] = useState(() => {
    onMount();
    return "same-instance";
  });
  const [errorCount, setErrorCount] = useState(0);

  return (
    <>
      <span data-locale>{locale}</span>
      <span data-theme>{theme}</span>
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

function ThemeHarness({ onMount }: { onMount?: () => void }) {
  const { theme, themePending, setTheme } = useAppTheme();
  useState(() => onMount?.());
  const [errorCount, setErrorCount] = useState(0);

  return (
    <>
      <span data-theme>{theme}</span>
      <span data-theme-pending>{themePending ? "pending" : "ready"}</span>
      <span data-theme-error-count>{errorCount}</span>
      <button
        type="button"
        data-change-theme
        onClick={() => {
          void setTheme(theme === "dark" ? "light" : "dark").catch(() => {
            setErrorCount((count) => count + 1);
          });
        }}
      />
      <button
        type="button"
        data-keep-theme
        onClick={() => void setTheme(theme)}
      />
      <button
        type="button"
        data-system-theme
        onClick={() => void setTheme("system")}
      />
    </>
  );
}

function LocalizedLabel() {
  return <span data-localized-label>{m.settings_language_label()}</span>;
}

interface AppSettingsResponse {
  language: string;
  theme: string;
  themeNeedsRecovery: boolean;
}

function appPreferences(
  language: string,
  theme = "system",
  themeNeedsRecovery = false,
): AppSettingsResponse {
  return {
    language,
    theme,
    themeNeedsRecovery,
  };
}

const WINDOW_THEME_COMMAND = "plugin:app|set_app_theme";

function windowThemeArg(args: unknown): string | null {
  return (args as { theme?: string | null } | undefined)?.theme ?? null;
}

/** Answers the window theme command so handlers list only preference commands. */
function mockPreferencesIpc(
  handler: Parameters<typeof mockNativeIpc>[0],
  options?: Parameters<typeof mockNativeIpc>[1],
) {
  mockNativeIpc(
    (command, args) =>
      command === WINDOW_THEME_COMMAND ? null : handler(command, args),
    options,
  );
}

/**
 * A WebView whose `prefers-color-scheme` follows the theme given to its
 * windows and, without one, the OS theme.
 */
function installWebViewTheme(dom: JSDOM, initialOsDark: boolean) {
  let osDark = initialOsDark;
  let windowTheme: string | null = null;
  const windowThemes: Array<string | null> = [];
  const reads: Array<{ windowTheme: string | null }> = [];
  const listeners = new Set<() => void>();
  const matches = () => (windowTheme ?? (osDark ? "dark" : "light")) === "dark";
  const mediaQuery = {
    get matches() {
      reads.push({ windowTheme });
      return matches();
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as MediaQueryList;
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => mediaQuery,
  });
  const update = (change: () => void) => {
    const before = matches();
    change();
    if (matches() !== before) for (const listener of listeners) listener();
  };

  return {
    reads,
    windowThemes,
    setOsDark(nextOsDark: boolean) {
      update(() => (osDark = nextOsDark));
    },
    setWindowTheme(nextWindowTheme: string | null) {
      windowThemes.push(nextWindowTheme);
      update(() => (windowTheme = nextWindowTheme));
    },
  };
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html lang=en><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installSystemTheme(dom: JSDOM, initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as MediaQueryList;
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => mediaQuery,
  });

  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      for (const listener of listeners) listener();
    },
  };
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
