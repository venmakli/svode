import type {
  SpeechJobDto,
  SpeechModelDto,
  SpeechModelProgressDto,
  SpeechModelsDto,
} from "@/platform/speech/speech-api";

/**
 * Where dictation stands with its model (`06`, states of the enable
 * popover): ready with the active model, or the model the user enables
 * it with — offered, downloading, preparing or failed.
 */
export type VoiceModelState =
  | { kind: "ready"; model: SpeechModelDto }
  | { kind: "missing"; model: SpeechModelDto }
  | { kind: "downloading"; model: SpeechModelDto; received: number; total: number }
  | { kind: "preparing"; model: SpeechModelDto }
  | {
      kind: "failed";
      model: SpeechModelDto;
      failure: Extract<SpeechJobDto, { stage: "failed" }>["failure"];
    };

export function voiceModelState(models: SpeechModelsDto): VoiceModelState {
  const active = models.models.find((model) => model.id === models.activeModel);
  if (active) return { kind: "ready", model: active };
  const recommended =
    models.models.find((model) => model.id === models.recommendation.modelId) ??
    models.models[0];
  // A job of the recommended model first: that is the one the popover
  // offers; otherwise any model being enabled from Settings.
  const working = recommended?.job
    ? recommended
    : models.models.find((model) => model.job !== null);
  const job = working?.job;
  if (working && job) {
    switch (job.stage) {
      case "downloading":
        return {
          kind: "downloading",
          model: working,
          received: job.received,
          total: job.total,
        };
      case "preparing":
        return { kind: "preparing", model: working };
      case "failed":
        return { kind: "failed", model: working, failure: job.failure };
    }
  }
  return { kind: "missing", model: recommended };
}

/**
 * V7 after the measurement: the active accurate model measured slow, so
 * the fast one is offered — to choose when installed, to download
 * otherwise. Null when nothing is to be offered.
 */
export function slowerModelOffer(
  models: SpeechModelsDto,
): { model: SpeechModelDto; installed: boolean } | null {
  const active = models.models.find((model) => model.id === models.activeModel);
  if (active?.mark !== "accurate" || !models.recommendation.accurateSlow) return null;
  const fast = models.models.find((model) => model.mark === "fast");
  if (!fast) return null;
  return { model: fast, installed: fast.installation === "current" || fast.installation === "outdated" };
}

/** Applies a progress event to the list without reading it again. */
export function withProgress(
  models: SpeechModelsDto,
  progress: SpeechModelProgressDto,
): SpeechModelsDto {
  return {
    ...models,
    models: models.models.map((model) =>
      model.id === progress.id && model.job?.stage === "downloading"
        ? {
            ...model,
            job: { stage: "downloading", received: progress.received, total: progress.total },
          }
        : model,
    ),
  };
}

/** Whole megabytes, as the popover and Settings name a download. */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000));
}
