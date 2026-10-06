export { useDictation, type Dictation } from "./hooks/use-dictation";
export { dictatedText, showsRecordingRow } from "./model/dictation";
export { DICTATION_KEY_CODE, dictationShortcut } from "./model/shortcut";
export { RecordingRow } from "./ui/recording-row";
export { VoiceInputButton } from "./ui/voice-input-button";
export {
  activateSpeechModel,
  cancelSpeechModel,
  deleteSpeechModel,
  installSpeechModel,
  prepareSpeechModel,
  setSpeechLanguage,
  type SpeechJobDto,
  type SpeechLanguageDto,
  type SpeechModelDto,
  type SpeechModelsDto,
} from "./api";
export { useSpeechModels } from "./hooks/use-speech-models";
export {
  activeModelJob,
  AUTO_LANGUAGE,
  installedModels,
  isInstalled,
  megabytes,
  slowerModelOffer,
  speechLanguageChoice,
  type InstalledModelView,
} from "./model/models";
export { registerVoiceSettingsOpener } from "./model/settings-opener";
