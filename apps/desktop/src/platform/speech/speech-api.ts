import { invokeCommand } from "@/platform/native/invoke";

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
