import { expect, test } from "bun:test";
import { setLocale } from "@/paraglide/runtime";
import { createAgentAdapterDictionary } from "./dictionary";

const registry = [
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
];

test("labels come from the registry and colors from the one dictionary", () => {
  setLocale("en", { reload: false });
  const agents = createAgentAdapterDictionary(registry);

  expect(agents.label("claude-code")).toBe("Claude Code");
  expect(agents.color("codex")).toBe("blue");
  expect(agents.color("claude-code")).toBe("orange");
  expect(agents.label("unknown")).toBe("Agent");
  expect(agents.color("unknown")).toBe("neutral");
  expect(agents.options()).toEqual([
    { name: "Codex", color: "blue" },
    { name: "Claude Code", color: "orange" },
  ]);
});

test("a new registry adapter becomes an option without a collection change", () => {
  setLocale("en", { reload: false });
  const agents = createAgentAdapterDictionary([
    ...registry,
    { id: "opencode", displayName: "opencode" },
  ]);

  expect(agents.label("opencode")).toBe("opencode");
  expect(agents.options().map((option) => option.name)).toEqual([
    "Codex",
    "Claude Code",
    "opencode",
  ]);
  expect(agents.color("opencode")).toBe("neutral");
});

test("unregistered adapters add one neutral fallback option", () => {
  setLocale("en", { reload: false });
  const agents = createAgentAdapterDictionary(registry);

  expect(agents.options(["codex", "unknown", "other"])).toEqual([
    { name: "Codex", color: "blue" },
    { name: "Claude Code", color: "orange" },
    { name: "Agent", color: "neutral" },
  ]);
  expect(agents.options(["codex"]).length).toBe(2);
});

test("built-in agents get their brand icon and the others their first letter", () => {
  setLocale("en", { reload: false });
  const agents = createAgentAdapterDictionary([
    ...registry,
    { id: "custom-local-llm", displayName: "local llm" },
  ]);

  const codex = agents.icon("codex");
  expect(codex.kind).toBe("brand");
  expect(codex.kind === "brand" && codex.src.length > 0).toBe(true);
  expect(agents.icon("custom-local-llm")).toEqual({
    kind: "letter",
    letter: "L",
  });
  expect(agents.icon("future-agent")).toEqual({ kind: "letter", letter: "A" });
});
