export interface AppOwner {
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  ownerPath: string;
}

export type AppRuntimeType = "static" | "process" | "url";

export interface AppManifestDiagnostic {
  code: string;
  path: string;
  message: string;
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
      runtimeType: AppRuntimeType;
      reason: string;
      browserUrl?: string;
    }
  | {
      status: "ready";
      ownerDirectory: string;
      runtimeType: "static" | "url";
      viewportUrl: string;
      capabilityToken?: string;
    };
