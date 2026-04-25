import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type {
  FanoutPreviewEntry,
  GitIdentity,
  RepoIdentityResult,
} from "@/features/identity/types";

interface Props {
  isRoot: boolean;
  repoIdentity: RepoIdentityResult | null;
  identityName: string;
  identityEmail: string;
  setIdentityName: (v: string) => void;
  setIdentityEmail: (v: string) => void;
  identityFormError: string | null;
  savingIdentity: boolean;
  onSave: () => void;
  fanoutEnabled: boolean;
  setFanoutEnabled: (v: boolean) => void;
  fanoutPreview: FanoutPreviewEntry[];
  fanoutSelected: Record<string, boolean>;
  setFanoutSelected: (next: Record<string, boolean>) => void;
  plannedName: string;
  plannedEmail: string;
}

function effectiveLabel(
  result: RepoIdentityResult | null,
  isRoot: boolean,
): string {
  if (!result || !result.effective) {
    return m.settings_git_identity_effective_missing();
  }
  const { name, email } = result.effective;
  if (result.source === "local") {
    return isRoot
      ? m.settings_git_identity_effective_project_override({ name, email })
      : m.settings_git_identity_effective_space_override({ name, email });
  }
  return m.settings_git_identity_effective_global({ name, email });
}

function differs(current: GitIdentity | null, name: string, email: string): boolean {
  if (!current) return false;
  if (!name && !email) return true;
  return current.name !== name || current.email !== email;
}

export function IdentitySection({
  isRoot,
  repoIdentity,
  identityName,
  identityEmail,
  setIdentityName,
  setIdentityEmail,
  identityFormError,
  savingIdentity,
  onSave,
  fanoutEnabled,
  setFanoutEnabled,
  fanoutPreview,
  fanoutSelected,
  setFanoutSelected,
  plannedName,
  plannedEmail,
}: Props) {
  const showFanout = isRoot && fanoutPreview.length > 0;

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">
        {m.settings_git_identity_override_title()}
      </Label>
      <div className="space-y-2">
        <Label htmlFor="ws-identity-name">{m.identity_name_label()}</Label>
        <Input
          id="ws-identity-name"
          value={identityName}
          onChange={(e) => setIdentityName(e.target.value)}
          placeholder={m.settings_git_identity_name_placeholder()}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="ws-identity-email">{m.identity_email_label()}</Label>
        <Input
          id="ws-identity-email"
          type="email"
          value={identityEmail}
          onChange={(e) => setIdentityEmail(e.target.value)}
          placeholder={m.settings_git_identity_email_placeholder()}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {effectiveLabel(repoIdentity, isRoot)}
      </p>
      {identityFormError && (
        <p className="text-xs text-destructive">{identityFormError}</p>
      )}

      {showFanout && (
        <div className="space-y-2 pt-1">
          <label className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              checked={fanoutEnabled}
              onCheckedChange={(checked) => setFanoutEnabled(checked === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              {m.settings_git_identity_fanout_checkbox()}
            </span>
          </label>
          {fanoutEnabled && (
            <div className="space-y-1 pl-6">
              <p className="text-xs text-muted-foreground">
                {m.settings_git_identity_fanout_affected_spaces()}
              </p>
              {fanoutPreview.map((entry) => {
                const willReplace = differs(
                  entry.currentLocal,
                  plannedName,
                  plannedEmail,
                );
                const checked = fanoutSelected[entry.spacePath] ?? true;
                return (
                  <label
                    key={entry.spacePath}
                    className="flex items-center gap-2 cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(c) =>
                        setFanoutSelected({
                          ...fanoutSelected,
                          [entry.spacePath]: c === true,
                        })
                      }
                    />
                    <span className="flex-1 truncate">{entry.spaceName}</span>
                    {willReplace && (
                      <Badge variant="secondary" className="text-xs font-normal">
                        {m.settings_git_identity_fanout_will_replace()}
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="pt-1">
        <Button onClick={onSave} disabled={savingIdentity}>
          {m.identity_save()}
        </Button>
      </div>
    </div>
  );
}
