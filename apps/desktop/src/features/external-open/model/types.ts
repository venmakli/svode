import type { ExternalAppDto } from "@/platform/project-openers";

export type ExternalApp = ExternalAppDto;

/** Something that can be opened in an external application. */
export interface ExternalOpenTarget {
  /** Device-local preference slot shared by every target of this kind. */
  preferenceKey: string;
  listApps(): Promise<readonly ExternalApp[]>;
  /** `null` hands the choice to the OS default application. */
  open(appId: string | null): Promise<void>;
  /** Shows the target selected in the file manager; offered for files only. */
  reveal?(): Promise<void>;
}

/** A target together with the surface that reports its failures. */
export interface ExternalOpenBinding {
  target: ExternalOpenTarget;
  onError(error: unknown, app: ExternalApp | null): void;
}
