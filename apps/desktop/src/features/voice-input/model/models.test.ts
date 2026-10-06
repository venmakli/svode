import { expect, test } from "bun:test";
import type { SpeechModelDto, SpeechModelsDto } from "@/platform/speech/speech-api";
import { megabytes, slowerModelOffer, voiceModelState, withProgress } from "./models";

function model(id: string, init: Partial<SpeechModelDto> = {}): SpeechModelDto {
  return {
    id,
    name: id,
    family: "whisper",
    size: 886_000_000,
    languages: { ru: "ru", en: "en" },
    detectsLanguage: true,
    installation: null,
    installedSize: null,
    measurement: null,
    job: null,
    ...init,
  };
}

function catalog(init: Partial<SpeechModelsDto> = {}, models?: SpeechModelDto[]): SpeechModelsDto {
  return {
    models: models ?? [
      model("turbo", { mark: "accurate" }),
      model("parakeet", { mark: "fast", size: 740_000_000 }),
      model("tiny"),
    ],
    unsupported: [],
    activeModel: null,
    recommendation: { modelId: "turbo", model: "accurate", measured: false, accurateSlow: false },
    ...init,
  };
}

test("without a model the popover offers the one recommended for this device", () => {
  const state = voiceModelState(
    catalog({ recommendation: { modelId: "parakeet", model: "fast", measured: false, accurateSlow: false } }),
  );
  expect(state.kind).toBe("missing");
  expect(state.model.id).toBe("parakeet");
});

test("an active model makes dictation ready", () => {
  const state = voiceModelState(catalog({ activeModel: "tiny" }));
  expect([state.kind, state.model.id]).toEqual(["ready", "tiny"]);
});

test("the job of the model being enabled shows its stage", () => {
  const downloading = catalog({}, [
    model("turbo", { mark: "accurate", job: { stage: "downloading", received: 10, total: 100 } }),
  ]);
  const before = voiceModelState(downloading);
  expect(before.kind === "downloading" && [before.received, before.total]).toEqual([10, 100]);
  const progressed = voiceModelState(
    withProgress(downloading, { id: "turbo", received: 60, total: 100 }),
  );
  expect(progressed.kind === "downloading" && progressed.received).toBe(60);
  expect(
    voiceModelState(catalog({}, [model("turbo", { job: { stage: "preparing" } })])).kind,
  ).toBe("preparing");
  const failed = voiceModelState(
    catalog({}, [model("turbo", { job: { stage: "failed", failure: "integrity" } })]),
  );
  expect(failed.kind === "failed" && failed.failure).toBe("integrity");
  // A model enabled from Settings shows too.
  const settings = voiceModelState(
    catalog({}, [model("turbo"), model("tiny", { job: { stage: "preparing" } })]),
  );
  expect([settings.kind, settings.model.id]).toEqual(["preparing", "tiny"]);
});

test("after a slow measurement of the accurate model the fast one is offered", () => {
  const slow = { modelId: "parakeet", model: "fast" as const, measured: true, accurateSlow: true };
  const offer = slowerModelOffer(catalog({ activeModel: "turbo", recommendation: slow }));
  expect([offer?.model.id, offer?.installed]).toEqual(["parakeet", false]);
  const installed = catalog({ activeModel: "turbo", recommendation: slow }, [
    model("turbo", { mark: "accurate", installation: "current" }),
    model("parakeet", { mark: "fast", installation: "current" }),
  ]);
  expect(slowerModelOffer(installed)?.installed).toBe(true);
  // Nothing to offer for a fast measurement or another active model.
  expect(slowerModelOffer(catalog({ activeModel: "turbo" }))).toBeNull();
  expect(slowerModelOffer(catalog({ activeModel: "tiny", recommendation: slow }))).toBeNull();
});

test("sizes are whole megabytes", () => {
  expect(megabytes(886_000_000)).toBe(886);
  expect(megabytes(77_000)).toBe(1);
});
