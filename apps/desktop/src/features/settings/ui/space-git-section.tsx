import { useId, useRef, type ReactNode } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RepositoryAccessBadge, RepositoryAccessSummary } from "@/features/git";
import type {
  GitPolicyField,
  SpaceSettingsGit,
} from "../hooks/use-space-settings-git";
import type { SpaceSettingsIdentity } from "../hooks/use-space-settings-identity";
import { IdentitySection } from "./identity-section";
import {
  SettingsGroup,
  SettingsItem,
  SettingsRow,
  SettingsRowSkeleton,
} from "./settings-layout";

const pendingClassName =
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

// The Git groups of the project or of one space repository.
export function SpaceGitSection({
  spacePath,
  isRoot,
  projectName,
  git,
  identity,
}: {
  spacePath: string;
  isRoot: boolean;
  projectName: string;
  git: SpaceSettingsGit;
  identity: SpaceSettingsIdentity;
}) {
  const id = useId();
  const remoteInput = useRef<HTMLInputElement>(null);
  const hasRemote = Boolean(git.savedRemoteUrl.trim());
  const reconciliation = git.remoteUpdateResult?.trackedReconciliation;

  function policyRow(
    field: GitPolicyField,
    label: ReactNode,
    description: ReactNode,
    disabled = false,
  ) {
    const pending = git.policyPending.has(field);
    return (
      <SettingsRow
        key={field}
        label={label}
        description={description}
        htmlFor={`${id}-${field}`}
        data-disabled={disabled || undefined}
      >
        {pending ? (
          <LoaderCircle
            aria-hidden
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : null}
        <Switch
          id={`${id}-${field}`}
          checked={git[field]}
          disabled={disabled}
          aria-disabled={pending || undefined}
          className={pendingClassName}
          onCheckedChange={(value) => {
            if (!pending) void git.handlePolicyChange(field, value);
          }}
        />
      </SettingsRow>
    );
  }

  return (
    <>
      <SettingsGroup title={m.git_access_title()}>
        <RepositoryAccessSummary
          className="px-4 py-3"
          repositoryPath={spacePath}
          remoteUrl={git.remoteUrl}
          onEditRemote={() => remoteInput.current?.focus()}
        />
      </SettingsGroup>

      <SettingsGroup
        title={m.settings_git_connection_title()}
        aria-busy={!git.loaded || git.applyingRemote}
        callout={
          reconciliation?.status === "pending_repository_access" ? (
            <Alert>
              <TriangleAlert />
              <AlertTitle>
                {m.git_remote_reconciliation_pending_title()}
              </AlertTitle>
              <AlertDescription>
                {m.git_remote_reconciliation_pending_description()}
              </AlertDescription>
            </Alert>
          ) : reconciliation?.status === "failed" ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>
                {m.git_remote_reconciliation_failed_title()}
              </AlertTitle>
              <AlertDescription>
                {m.git_remote_reconciliation_failed_description({
                  error: reconciliation.message ?? m.toast_error(),
                })}
              </AlertDescription>
            </Alert>
          ) : null
        }
      >
        {git.loaded
          ? [
              <SettingsRow
                key="remote"
                label={m.git_remote_label()}
                htmlFor={`${id}-remote`}
                layout="stacked"
              >
                <div className="relative">
                  <Input
                    ref={remoteInput}
                    id={`${id}-remote`}
                    value={git.remoteUrl}
                    readOnly={git.applyingRemote}
                    aria-disabled={git.applyingRemote || undefined}
                    aria-busy={git.applyingRemote || undefined}
                    className={pendingClassName}
                    placeholder={m.git_remote_placeholder()}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(event) => git.setRemoteUrl(event.target.value)}
                    onBlur={git.handleRemoteBlur}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  {git.applyingRemote ? (
                    <LoaderCircle
                      aria-hidden
                      className="absolute top-2 right-2 size-4 animate-spin text-muted-foreground"
                    />
                  ) : null}
                </div>
              </SettingsRow>,
              git.gitType === "submodule" && git.submoduleUrl ? (
                <SettingsRow
                  key="submodule"
                  label={m.settings_git_submodule_url()}
                  description={m.settings_git_submodule_url_description({
                    name: projectName,
                  })}
                  layout="stacked"
                >
                  <p className="font-mono text-sm break-all text-muted-foreground">
                    {git.submoduleUrl}
                  </p>
                </SettingsRow>
              ) : null,
              <SettingsItem
                key="branch"
                title={m.git_branch_label()}
                actions={
                  <span className="text-sm break-all text-muted-foreground">
                    {git.branch ?? "—"}
                  </span>
                }
              />,
            ]
          : [
              <SettingsRowSkeleton key="loading-remote" />,
              <SettingsRowSkeleton key="loading-branch" />,
            ]}
      </SettingsGroup>

      <SettingsGroup
        title={m.settings_git_automation_title()}
        description={m.settings_git_automation_description()}
        aria-busy={!git.loaded}
      >
        {git.loaded
          ? [
              policyRow(
                "autoSync",
                m.git_auto_sync_checkbox(),
                hasRemote
                  ? m.git_auto_sync_hint()
                  : m.settings_git_auto_sync_no_remote(),
                !hasRemote,
              ),
              policyRow(
                "autoCommitStructural",
                m.git_auto_commit_structural_checkbox(),
                m.git_auto_commit_structural_hint(),
              ),
              policyRow(
                "autoCommitSystem",
                m.git_auto_commit_system_checkbox(),
                m.git_auto_commit_system_hint(),
              ),
            ]
          : [
              <SettingsRowSkeleton key="loading-sync" />,
              <SettingsRowSkeleton key="loading-structural" />,
              <SettingsRowSkeleton key="loading-system" />,
            ]}
      </SettingsGroup>

      <IdentitySection isRoot={isRoot} identity={identity} />
    </>
  );
}

// The summary of a collapsed repository block: access and remote. Reading
// the access status never starts a check.
export function SpaceGitSummary({
  repositoryPath,
  git,
}: {
  repositoryPath: string;
  git: SpaceSettingsGit;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <RepositoryAccessBadge repositoryPath={repositoryPath} />
      {git.loaded ? (
        <span className="min-w-0 break-all">
          {git.savedRemoteUrl || m.settings_git_remote_missing()}
        </span>
      ) : null}
    </span>
  );
}
