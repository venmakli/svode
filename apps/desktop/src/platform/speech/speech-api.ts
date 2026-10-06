import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand, NativeChannel } from "@/platform/native/invoke";

/** License and attribution of one model of the release speech catalog. */
export interface SpeechModelLicenseDto {
  id: string;
  name: string;
  license: { name: string; link: string | null };
  /** The model the GGUF file is converted from. */
  upstream: string;
  /** The repository the file is downloaded from. */
  repo: string;
}

export function listSpeechModelLicenses(): Promise<SpeechModelLicenseDto[]> {
  return invokeCommand<SpeechModelLicenseDto[]>("speech_model_licenses");
}

export type SpeechModelMarkDto = "accurate" | "fast";
export type SpeechLanguageDto = "ru" | "en";

export type SpeechJobDto =
  | { stage: "downloading"; received: number; total: number }
  | { stage: "preparing" }
  | {
      stage: "failed";
      failure: "network" | "integrity" | "disk" | "preparation";
    };

/** One model of the release catalog with its state on this device. */
export interface SpeechModelDto {
  id: string;
  name: string;
  family: string;
  mark?: SpeechModelMarkDto;
  /** File size in bytes. */
  size: number;
  /** The tag the model takes for each language it transcribes. */
  languages: Partial<Record<SpeechLanguageDto, string>>;
  detectsLanguage: boolean;
  installation: "current" | "outdated" | "unsupported" | null;
  installedSize: number | null;
  /** The last current measurement of the reference recording (V7). */
  measurement: { seconds: number; backend: string; version: string } | null;
  job: SpeechJobDto | null;
}

export interface SpeechModelsDto {
  models: SpeechModelDto[];
  unsupported: { id: string; file: string; size: number }[];
  activeModel: string | null;
  recommendation: {
    /** The model recommended for this device. */
    modelId: string;
    model: SpeechModelMarkDto;
    /** It rests on a measurement rather than the acceleration found. */
    measured: boolean;
    /** The accurate model measured slower than the limit. */
    accurateSlow: boolean;
  };
}

export interface SpeechModelProgressDto {
  id: string;
  received: number;
  total: number;
}

export function listSpeechModels(): Promise<SpeechModelsDto> {
  return invokeCommand<SpeechModelsDto>("speech_models");
}

/** Downloads, installs and prepares a model; progress comes as events. */
export function installSpeechModel(id: string): Promise<void> {
  return invokeCommand<void>("speech_model_install", { id });
}

export function cancelSpeechModel(id: string): Promise<void> {
  return invokeCommand<void>("speech_model_cancel", { id });
}

/** Prepares an installed model again after a failed preparation. */
export function prepareSpeechModel(id: string): Promise<void> {
  return invokeCommand<void>("speech_model_prepare", { id });
}

export function activateSpeechModel(id: string): Promise<void> {
  return invokeCommand<void>("speech_model_activate", { id });
}

export function listenSpeechModelsChanged(listener: () => void): Promise<UnlistenFn> {
  return listen<null>("speech-models-changed", () => listener());
}

export function listenSpeechModelProgress(
  listener: (progress: SpeechModelProgressDto) => void,
): Promise<UnlistenFn> {
  return listen<SpeechModelProgressDto>("speech-model-progress", (event) =>
    listener(event.payload),
  );
}

/** The composer of a webview that records, recognizes or holds a failure. */
export interface DictationOwnerDto {
  webview: string;
  key: string;
}

export type DictationFailureDto =
  | { code: "busy" }
  | { code: "modelMissing" }
  | {
      code: "denied";
      recovery:
        | { kind: "resetCommand"; command: string }
        | { kind: "openSettings" }
        | { kind: "none" };
    }
  | { code: "noDevice" }
  | { code: "noSignal"; soundSettings: boolean }
  | { code: "device" }
  | { code: "recognition" }
  | { code: "cancelled" };

export type DictationResultDto =
  | { outcome: "text"; text: string }
  | { outcome: "failed"; failure: DictationFailureDto };

/** The label the dictation owner of this webview carries. */
export function currentDictationWebview(): string {
  try {
    return getCurrentWebview().label;
  } catch {
    // Outside Tauri (tests) there is one webview.
    return "";
  }
}

export function getDictationOwner(): Promise<DictationOwnerDto | null> {
  return invokeCommand<DictationOwnerDto | null>("speech_dictation_owner");
}

export function listenDictationOwner(
  listener: (owner: DictationOwnerDto | null) => void,
): Promise<UnlistenFn> {
  return listen<DictationOwnerDto | null>("speech-dictation-changed", (event) =>
    listener(event.payload),
  );
}

/**
 * Starts recording for composer `key`; `onLevel` gets the dBFS of each
 * 50 ms window. Resolves to why it did not start, or null.
 */
export function startDictation(
  key: string,
  onLevel: (dbfs: number) => void,
): Promise<DictationFailureDto | null> {
  const levels = new NativeChannel<number>();
  levels.onmessage = onLevel;
  return invokeCommand<DictationFailureDto | null>("speech_dictation_start", {
    key,
    levels,
  });
}

/** Stops the recording and recognizes it, or recognizes a failed one again. */
export function finishDictation(key: string): Promise<DictationResultDto> {
  return invokeCommand<DictationResultDto>("speech_dictation_finish", { key });
}

export function cancelDictation(key: string): Promise<void> {
  return invokeCommand<void>("speech_dictation_cancel", { key });
}

export function openSpeechSystemSettings(
  target: "microphonePrivacy" | "soundInput",
): Promise<void> {
  return invokeCommand<void>("speech_open_system_settings", { target });
}
