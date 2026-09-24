import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { setLocale } from "@/paraglide/runtime";
import { DogfoodUpdatesProvider } from "@/features/updates";
import type { useAppSettingsAppearance } from "../hooks/use-app-settings-appearance";
import type { useGlobalIdentitySettings } from "../hooks/use-global-identity-settings";
import {
  AppAboutSection,
  AppAppearanceSection,
  AppGitIdentitySection,
} from "./app-settings-sections";

type Identity = ReturnType<typeof useGlobalIdentitySettings>;
type Appearance = ReturnType<typeof useAppSettingsAppearance>;

const noop = () => {};

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    identityName: "Ada",
    setIdentityName: noop,
    identityEmail: "ada@example.test",
    setIdentityEmail: noop,
    identityNameValid: true,
    identityEmailValid: true,
    identityStale: false,
    savingIdentity: false,
    canSaveIdentity: false,
    handleSaveIdentity: async () => {},
    handleUseLatestIdentity: noop,
    handleKeepIdentityDraft: noop,
    ...overrides,
  } as Identity;
}

function render(element: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(element)).window.document;
}

test("profile is one titled group with field rows, inline errors and a final save row", () => {
  setLocale("en", { reload: false });
  const document = render(<AppGitIdentitySection settings={identity()} />);
  const section = document.querySelector("section")!;
  expect(section.querySelector("h3")?.textContent).toBe("Git commit author");
  expect(section.querySelectorAll('[data-slot="card"]').length).toBe(1);
  const card = section.querySelector('[data-slot="card"]')!;
  const rows = Array.from(card.children).filter(
    (node) => node.getAttribute("data-slot") !== "separator",
  );
  expect(rows.length).toBe(3);
  expect(
    card.querySelector('label[for="settings-identity-name"]')?.textContent,
  ).toBe("Name");
  expect(card.querySelector("#settings-identity-email") !== null).toBe(true);
  expect(rows[2].querySelector("button")?.textContent).toBe("Save");
  expect(document.querySelector('[data-slot="alert"]')).toBeNull();

  const invalid = render(
    <AppGitIdentitySection
      settings={identity({
        identityEmail: "nope",
        identityEmailValid: false,
        identityStale: true,
      })}
    />,
  );
  const error = invalid.querySelector('[data-slot="field-error"]')!;
  expect(error.textContent).toBe("Invalid email address");
  expect(
    Boolean(
      error
        .closest('[data-slot="field"]')
        ?.querySelector("#settings-identity-email"),
    ),
  ).toBe(true);
  const alert = invalid.querySelector('section > [data-slot="alert"]')!;
  expect(alert.textContent?.includes("Commit author changed")).toBe(true);
  expect(alert.nextElementSibling?.getAttribute("data-slot")).toBe("card");
});

test("appearance rows use labelled selects that show only the selected label", () => {
  setLocale("ru", { reload: false });
  try {
    const settings: Appearance = {
      theme: "system",
      themePending: true,
      locale: "ru",
      localePending: false,
      handleThemeChange: async () => {},
      handleLanguageChange: async () => {},
    };
    const document = render(<AppAppearanceSection settings={settings} />);
    expect(document.querySelector("section h3")).toBeNull();
    expect(document.querySelector("section p")?.textContent).toBe(
      "Тема и язык применяются ко всем окнам Svode на этом устройстве.",
    );
    const theme = document.querySelector<HTMLButtonElement>(
      "#app-settings-theme",
    )!;
    expect(
      document.querySelector('label[for="app-settings-theme"]')?.textContent,
    ).toBe("Тема");
    expect(theme.getAttribute("role")).toBe("combobox");
    expect(theme.textContent).toBe("Системная");
    expect(theme.hasAttribute("disabled")).toBe(false);
    expect(theme.getAttribute("aria-disabled")).toBe("true");
    expect(theme.getAttribute("aria-busy")).toBe("true");
    const language = document.querySelector("#app-settings-language")!;
    expect(language.textContent).toBe("Русский");
    expect(language.hasAttribute("disabled")).toBe(false);
  } finally {
    setLocale("en", { reload: false });
  }
});

test("about is one group of value, update and release rows", async () => {
  setLocale("en", { reload: false });
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { url: "http://localhost/" },
  );
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  try {
    await act(async () =>
      root.render(
        <DogfoodUpdatesProvider version="0.0.8" buildCommit="abc123">
          <AppAboutSection
            version="0.0.8"
            buildCommit="abc123"
            releaseUrl="https://example.test/releases"
          />
        </DogfoodUpdatesProvider>,
      ),
    );
    const document = dom.window.document;
    const rows = Array.from(document.querySelectorAll('[data-slot="item"]'));
    expect(
      rows.map(
        (row) => row.querySelector('[data-slot="item-title"]')?.textContent,
      ),
    ).toEqual(["Version", "Build commit", "Updates", "Releases"]);
    expect(
      rows[0].querySelector('[data-slot="item-actions"]')?.textContent,
    ).toBe("0.0.8");
    expect(
      rows[2].querySelector('[data-slot="item-description"]')?.textContent,
    ).toBe("Manual updates via GitHub Releases");
    expect(rows[2].querySelector("button")?.textContent).toBe(
      "Check for updates",
    );
    const link = rows[3].querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.test/releases");
    expect(link.textContent).toBe("Open on GitHub");
    expect(document.querySelectorAll('[data-slot="card"]').length).toBe(1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
