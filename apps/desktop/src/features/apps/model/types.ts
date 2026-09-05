export interface AppOwner {
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  ownerPath: string;
}

export type AppRuntimeType = "static" | "process" | "url";
export type AppProcessPhase = "setup" | "starting" | "waiting_for_url";
export type AppProcessControlAction =
  | "retry"
  | "restart"
  | "stop"
  | "rerun_setup";

export interface AppProcessLogs {
  stdout: string;
  stderr: string;
}

export interface AppProcessDetails {
  managed: boolean;
  hasSetup: boolean;
  logs: AppProcessLogs;
}

export interface AppManifestDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface MissingAppVariable {
  referenceName: string;
  entryName: string;
}

export type AppManifestInspection = Exclude<
  AppSession,
  { status: "loading" | "error" }
>;

export type AppSession =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing"; ownerDirectory: string }
  | {
      status: "invalid";
      ownerDirectory: string;
      diagnostics: AppManifestDiagnostic[];
    }
  | {
      status: "unavailable";
      ownerDirectory: string;
      runtimeType: Exclude<AppRuntimeType, "process">;
      reason: string;
      browserUrl?: string;
      process?: never;
    }
  | {
      status: "unavailable";
      ownerDirectory: string;
      runtimeType: "process";
      reason: string;
      browserUrl?: string;
      process: AppProcessDetails;
      missingVariables?: MissingAppVariable[];
    }
  | {
      status: "launching";
      ownerDirectory: string;
      runtimeType: "process";
      phase: AppProcessPhase;
      browserUrl: string;
      process: AppProcessDetails;
    }
  | {
      status: "ready";
      ownerDirectory: string;
      runtimeType: Exclude<AppRuntimeType, "process">;
      viewportUrl: string;
      capabilityToken?: string;
      process?: never;
    }
  | {
      status: "ready";
      ownerDirectory: string;
      runtimeType: "process";
      viewportUrl: string;
      capabilityToken?: never;
      process: AppProcessDetails;
    };
