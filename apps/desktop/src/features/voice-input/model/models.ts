import type {
  SpeechJobDto,
  SpeechLanguageDto,
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
  return { model: fast, installed: isInstalled(fast) };
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

export function isInstalled(model: SpeechModelDto): boolean {
  return model.installation === "current" || model.installation === "outdated";
}

/** "Авто" in the speech language select. */
export const AUTO_LANGUAGE = "auto";

/**
 * The speech languages a model offers (`06`, "Язык речи"): "Авто" when it
 * detects among several, then its languages; a model of one language
 * names it and offers no choice.
 */
export function speechLanguageChoice(
  model: SpeechModelDto,
):
  | { kind: "only"; language: SpeechLanguageDto }
  | { kind: "choice"; options: (SpeechLanguageDto | typeof AUTO_LANGUAGE)[] } {
  const languages = SPEECH_LANGUAGES.filter((language) => language in model.languages);
  if (languages.length === 1) return { kind: "only", language: languages[0] };
  return {
    kind: "choice",
    options: model.detectsLanguage ? [AUTO_LANGUAGE, ...languages] : languages,
  };
}

const SPEECH_LANGUAGES: SpeechLanguageDto[] = ["ru", "en"];

/** One installed model in "Установленные модели", the dropped ones last. */
export interface InstalledModelView {
  id: string;
  name: string;
  /** Bytes on this device. */
  size: number;
  active: boolean;
  installation: "current" | "outdated" | "unsupported";
  /** The catalog entry; none for a model the release dropped. */
  model: SpeechModelDto | null;
}

export function installedModels(models: SpeechModelsDto): {
  models: InstalledModelView[];
  /** Bytes all of them take. */
  size: number;
} {
  const installed: InstalledModelView[] = models.models
    .filter(isInstalled)
    .map((model) => ({
      id: model.id,
      name: model.name,
      size: model.installedSize ?? model.size,
      active: model.id === models.activeModel,
      installation: model.installation === "outdated" ? "outdated" : "current",
      model,
    }));
  for (const dropped of models.unsupported) {
    installed.push({
      id: dropped.id,
      name: dropped.id,
      size: dropped.size,
      active: false,
      installation: "unsupported",
      model: null,
    });
  }
  return {
    models: installed,
    size: installed.reduce((total, model) => total + model.size, 0),
  };
}

/**
 * The job the "Модель" row shows: that of the active model (preparing it
 * again), else of a model being downloaded to become active.
 */
export function activeModelJob(
  models: SpeechModelsDto,
): { model: SpeechModelDto; job: SpeechJobDto } | null {
  const working =
    models.models.find((model) => model.id === models.activeModel && model.job) ??
    models.models.find((model) => !isInstalled(model) && model.job);
  return working?.job ? { model: working, job: working.job } : null;
}
