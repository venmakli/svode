export interface AvailableAgent {
  name: string;
  path: string;
  version: string | null;
  authStatus: string;
  docsUrl: string;
}

export interface AppPreferences {
  theme: string;
  language: string;
  themeNeedsRecovery: boolean;
}

export interface SymlinkHealthReport {
  ok: number;
  restored: number;
  errors: string[];
}
