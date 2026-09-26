import type { ExternalAppDto } from "@/platform/project-openers";

export type ExternalApp = ExternalAppDto;

/** Something that can be opened in an external application. */
export interface ExternalOpenTarget {
  /** Device-local preference slot shared by every target of this kind. */
  preferenceKey: string;
  listApps(): Promise<readonly ExternalApp[]>;
  /** `null` hands the choice to the OS default application. */
  open(appId: string | null): Promise<void>;
}
