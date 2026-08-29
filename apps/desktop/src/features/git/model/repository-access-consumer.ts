import type { RepositoryAccessView } from "./repository-access-owner";

export type RepositoryAccessContinuationPolicy = "automatic" | "explicit";
export type RepositoryAccessRecoveryPlacement = "dialog" | "inline";

export interface RepositoryAccessTarget {
  displayName: string;
  displayPath: string;
  repositoryPath: string;
  openSettings?: () => void;
}

export interface RepositoryAccessRequest {
  continuation: RepositoryAccessContinuationPolicy;
  continue(): void | Promise<void>;
  intentKey: string;
  intentLabel: string;
  onPlanChanged?: () => void | Promise<void>;
  placement: RepositoryAccessRecoveryPlacement;
  targets: readonly RepositoryAccessTarget[];
}

export interface RepositoryAccessTargetView {
  access: RepositoryAccessView;
  target: RepositoryAccessTarget;
}

export function allowsRepositoryMutation(view: RepositoryAccessView) {
  return (
    view.snapshot?.status === "local" || view.snapshot?.status === "writable"
  );
}

export function dedupeRepositoryAccessTargets(
  targets: readonly RepositoryAccessTarget[],
  getView: (repositoryPath: string) => RepositoryAccessView,
): RepositoryAccessTargetView[] {
  const seenKeys = new Set<string>();
  const result: RepositoryAccessTargetView[] = [];

  for (const target of targets) {
    const access = getView(target.repositoryPath);
    const key =
      access.snapshot?.repositoryId ?? `path:${target.repositoryPath}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    result.push({ access, target });
  }

  return result;
}

export function blockingRepositoryAccessTargets(
  targets: readonly RepositoryAccessTargetView[],
) {
  return targets.filter(({ access }) => !allowsRepositoryMutation(access));
}
