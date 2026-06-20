import * as m from "@/paraglide/messages.js";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type {
  FanoutPreviewEntry,
  RepoIdentityResult,
} from "@/features/identity";
import type { SpaceGitType } from "@/features/space";
import { IdentitySection } from "./identity-section";

interface SpaceGitSectionProps {
  gitType: SpaceGitType | null;
  activeRootName: string | null;
  isRoot: boolean;
  submoduleUrl: string | null;
  remoteUrl: string;
  branch: string | null;
  autoSync: boolean;
  autoCommitStructural: boolean;
  autoCommitSystem: boolean;
  repoIdentity: RepoIdentityResult | null;
  identityName: string;
  identityEmail: string;
  identityFormError: string | null;
  savingIdentity: boolean;
  fanoutEnabled: boolean;
  fanoutPreview: FanoutPreviewEntry[];
  fanoutSelected: Record<string, boolean>;
  onRemoteChange: (value: string) => void;
  onRemoteBlur: () => void;
  onAutoSyncChange: (value: boolean) => void;
  onAutoCommitStructuralChange: (value: boolean) => void;
  onAutoCommitSystemChange: (value: boolean) => void;
  onIdentityNameChange: (value: string) => void;
  onIdentityEmailChange: (value: string) => void;
  onSaveIdentity: () => void;
  onFanoutEnabledChange: (value: boolean) => void;
  onFanoutSelectedChange: (value: Record<string, boolean>) => void;
}

export function SpaceGitSection({
  gitType,
  activeRootName,
  isRoot,
  submoduleUrl,
  remoteUrl,
  branch,
  autoSync,
  autoCommitStructural,
  autoCommitSystem,
  repoIdentity,
  identityName,
  identityEmail,
  identityFormError,
  savingIdentity,
  fanoutEnabled,
  fanoutPreview,
  fanoutSelected,
  onRemoteChange,
  onRemoteBlur,
  onAutoSyncChange,
  onAutoCommitStructuralChange,
  onAutoCommitSystemChange,
  onIdentityNameChange,
  onIdentityEmailChange,
  onSaveIdentity,
  onFanoutEnabledChange,
  onFanoutSelectedChange,
}: SpaceGitSectionProps) {
  return (
    <div className="flex max-w-sm flex-col gap-6">
      {gitType === "inline" && (
        <p className="text-sm text-muted-foreground">
          {m.git_type_inline_note({ name: activeRootName ?? "" })}
        </p>
      )}
      {gitType === "submodule" && (
        <>
          <p className="text-sm text-muted-foreground">
            {m.git_type_submodule_note({ name: activeRootName ?? "" })}
          </p>
          {submoduleUrl && (
            <div className="flex flex-col gap-2">
              <Label>{m.git_remote_label()}</Label>
              <p className="text-sm text-muted-foreground break-all">
                {submoduleUrl}
              </p>
            </div>
          )}
        </>
      )}
      {(isRoot || gitType === "independent" || gitType === null) && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ws-git-remote">{m.git_remote_label()}</Label>
            <Input
              id="ws-git-remote"
              value={remoteUrl}
              onChange={(event) => onRemoteChange(event.target.value)}
              onBlur={onRemoteBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              placeholder={m.git_remote_placeholder()}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>{m.git_branch_label()}</Label>
            <p className="text-sm text-muted-foreground">{branch ?? "—"}</p>
          </div>
          {remoteUrl.trim() && (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <Label>{m.git_auto_sync_label()}</Label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <Checkbox
                    checked={autoSync}
                    onCheckedChange={(checked) =>
                      onAutoSyncChange(checked === true)
                    }
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    {m.git_auto_sync_checkbox()}
                    <span className="block text-xs text-muted-foreground">
                      {m.git_auto_sync_hint()}
                    </span>
                  </span>
                </label>
              </div>
            </>
          )}
          <Separator />
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label>{m.git_auto_commit_label()}</Label>
              <p className="text-xs text-muted-foreground">
                {m.git_auto_commit_manual_hint()}
              </p>
            </div>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={autoCommitStructural}
                onCheckedChange={(checked) =>
                  onAutoCommitStructuralChange(checked === true)
                }
                className="mt-0.5"
              />
              <span className="text-sm">
                {m.git_auto_commit_structural_checkbox()}
                <span className="block text-xs text-muted-foreground">
                  {m.git_auto_commit_structural_hint()}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={autoCommitSystem}
                onCheckedChange={(checked) =>
                  onAutoCommitSystemChange(checked === true)
                }
                className="mt-0.5"
              />
              <span className="text-sm">
                {m.git_auto_commit_system_checkbox()}
                <span className="block text-xs text-muted-foreground">
                  {m.git_auto_commit_system_hint()}
                </span>
              </span>
            </label>
          </div>
        </>
      )}
      {gitType !== "inline" && (
        <>
          <Separator />
          <IdentitySection
            isRoot={isRoot}
            repoIdentity={repoIdentity}
            identityName={identityName}
            identityEmail={identityEmail}
            setIdentityName={onIdentityNameChange}
            setIdentityEmail={onIdentityEmailChange}
            identityFormError={identityFormError}
            savingIdentity={savingIdentity}
            onSave={onSaveIdentity}
            fanoutEnabled={fanoutEnabled}
            setFanoutEnabled={onFanoutEnabledChange}
            fanoutPreview={fanoutPreview}
            fanoutSelected={fanoutSelected}
            setFanoutSelected={onFanoutSelectedChange}
            plannedName={identityName.trim()}
            plannedEmail={identityEmail.trim()}
          />
        </>
      )}
    </div>
  );
}
