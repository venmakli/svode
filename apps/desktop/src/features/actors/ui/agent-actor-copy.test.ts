import { expect, test } from "bun:test";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type { AgentActorCatalogDiagnostic } from "../model/agent-actor-types";
import {
  AGENT_ACTOR_READINESS,
  agentActorAgentValue,
  agentActorCatalogDiagnosticText,
  agentActorModeLabel,
  agentActorReadinessLabel,
} from "./agent-actor-copy";

const facts = { model: null, mode: null, readiness: null };

test("Agent Actor copy follows the locale", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("ru", { reload: false });
    const copy = [
      agentActorModeLabel({ ...facts, mode: { kind: "agent_default" } }),
      ...AGENT_ACTOR_READINESS.map(agentActorReadinessLabel),
    ].join(" ");
    expect(copy.includes("По умолчанию агента")).toBe(true);
    expect(copy.includes("Агент по умолчанию не выбран")).toBe(true);
    expect(copy.includes("Значение больше не объявляется")).toBe(true);
    expect(/Participant|Ready|Not installed/.test(copy)).toBe(false);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("the Agent of a binding is its agent with the model, or the participant's agent", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("en", { reload: false });
    const codex = { agent: "codex", kind: "agent" as const, settings: [] };
    expect(agentActorAgentValue(codex, facts)).toEqual({
      agent: "codex",
      detail: null,
      kind: "agent",
    });
    expect(
      agentActorAgentValue(codex, { ...facts, model: "GPT-6 Sol" }),
    ).toEqual({ agent: "codex", detail: "GPT-6 Sol", kind: "agent" });
    expect(agentActorAgentValue({ kind: "participant" }, facts)).toEqual({
      kind: "participant",
    });
    expect(agentActorModeLabel(facts)).toBeNull();
    expect(
      agentActorModeLabel({
        ...facts,
        mode: { kind: "value", name: "Auto review" },
      }),
    ).toBe("Auto review");
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("an unavailable catalog reads by the class of its cause and names the project's catalog", async () => {
  const originalLocale = getLocale();
  const SPACE = "/project/team";
  const ROOT = "/project";
  const raw = "Agent catalog schema version 9 is newer than this version";
  const unavailable = (
    ownerPath: string,
    reason?: AgentActorCatalogDiagnostic["reason"],
  ): AgentActorCatalogDiagnostic => ({
    code: "catalog_unavailable",
    message: raw,
    ownerPath,
    ...(reason ? { reason } : {}),
  });
  const text = (
    ownerPath: string,
    reason?: AgentActorCatalogDiagnostic["reason"],
  ) => agentActorCatalogDiagnosticText(unavailable(ownerPath, reason), SPACE);
  const expected = {
    en: {
      newer_format: [
        "The agent catalog was written by a newer version of Svode. Update Svode to see and edit these agents.",
        "The project’s agent catalog was written by a newer version of Svode. Update Svode to see and edit the project’s agents.",
      ],
      damaged: [
        "The agent catalog file is damaged. Fix .svode/agent-actors.json or restore its previous version.",
        "The project’s agent catalog file is damaged. Fix .svode/agent-actors.json in the project root or restore its previous version.",
      ],
      unreadable: [
        "The agent catalog file could not be read. Check access to .svode/agent-actors.json.",
        "The project’s agent catalog file could not be read. Check access to .svode/agent-actors.json in the project root.",
      ],
      none: [
        "The agent catalog is unavailable.",
        "The project’s agent catalog is unavailable.",
      ],
    },
    ru: {
      newer_format: [
        "Каталог агентов записан более новой версией Svode. Обновите Svode, чтобы увидеть и изменять этих агентов.",
        "Каталог агентов проекта записан более новой версией Svode. Обновите Svode, чтобы увидеть и изменять агентов проекта.",
      ],
      damaged: [
        "Файл каталога агентов повреждён. Исправьте .svode/agent-actors.json или верните его прежнюю версию.",
        "Файл каталога агентов проекта повреждён. Исправьте .svode/agent-actors.json в корне проекта или верните его прежнюю версию.",
      ],
      unreadable: [
        "Не удалось прочитать файл каталога агентов. Проверьте доступ к .svode/agent-actors.json.",
        "Не удалось прочитать файл каталога агентов проекта. Проверьте доступ к .svode/agent-actors.json в корне проекта.",
      ],
      none: [
        "Каталог агентов недоступен.",
        "Каталог агентов проекта недоступен.",
      ],
    },
  } as const;
  try {
    for (const locale of ["en", "ru"] as const) {
      await setLocale(locale, { reload: false });
      const copy = expected[locale];
      for (const reason of ["newer_format", "damaged", "unreadable"] as const) {
        expect(text(SPACE, reason)).toBe(copy[reason][0]);
        expect(text(ROOT, reason)).toBe(copy[reason][1]);
      }
      // A cause without a known class reads as the general text.
      expect(text(SPACE)).toBe(copy.none[0]);
      expect(text(ROOT)).toBe(copy.none[1]);
      expect(
        text(SPACE, "future_reason" as AgentActorCatalogDiagnostic["reason"]),
      ).toBe(copy.none[0]);
      for (const reason of [
        undefined,
        "newer_format",
        "damaged",
        "unreadable",
      ] as const) {
        for (const owner of [SPACE, ROOT]) {
          expect(text(owner, reason).includes(raw)).toBe(false);
        }
      }
    }
    // Any other diagnostic keeps its message, which names the agent.
    const ambiguous =
      "agent:01arz3ndektsv4rrffq69g5fav is defined by multiple effective catalogs";
    expect(
      agentActorCatalogDiagnosticText(
        { code: "ambiguous_actor_id", message: ambiguous, ownerPath: ROOT },
        SPACE,
      ),
    ).toBe(ambiguous);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});
