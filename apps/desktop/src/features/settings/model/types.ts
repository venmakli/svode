export interface AvailableAgent {
  name: string;
  path: string;
  version: string | null;
  authStatus: string;
  docsUrl: string;
}

export interface AppSettings {
  appearance: { theme: string; language: string };
  window: { width: number; height: number };
  agents?: AppAgentSettings;
}

export interface AppAgentSettings {
  detected: DetectedCli[];
  lastScan?: string;
}

export interface DetectedCli {
  name: string;
  path: string;
  version?: string;
  authStatus: string;
}

export interface SymlinkHealthReport {
  ok: number;
  restored: number;
  errors: string[];
}
