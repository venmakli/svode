let settingsOpener: (() => void) | null = null;

/** The app shell opens the "Голосовой ввод" group of App Settings. */
export function registerVoiceSettingsOpener(opener: () => void) {
  settingsOpener = opener;
  return () => {
    if (settingsOpener === opener) settingsOpener = null;
  };
}

export function voiceSettingsOpener(): (() => void) | undefined {
  return settingsOpener ?? undefined;
}
