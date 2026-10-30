import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SheetFooter } from "@/components/ui/sheet";
import type { GitCommitRefusal } from "@/features/git/editor";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  gitSaveErrorDescription,
  repositoryAccessPresentation,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import type { useChangesSave } from "../hooks/use-changes-save";

export function ChangesSaveFooter({
  save,
  dirty,
  statusError,
  fileScope,
  onChooseVersion,
}: {
  save: ReturnType<typeof useChangesSave>;
  dirty: boolean;
  statusError: boolean;
  fileScope: boolean;
  /** Leaves "Changes" for the version choice of the Page a refusal names. */
  onChooseVersion: (refusal: GitCommitRefusal) => void;
}) {
  const hint =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? fileScope
        ? "⌘S"
        : "⇧⌘S"
      : fileScope
        ? "Ctrl+S"
        : "Ctrl+Shift+S";
  if (!dirty && !save.error && !save.saving && !save.refusal) return null;
  const { refusal } = save;
  return (
    <SheetFooter className="shrink-0 border-t">
      {refusal ? (
        <Alert data-changes-commit-refused>
          <AlertDescription className="flex min-w-0 flex-col items-start gap-2 [overflow-wrap:anywhere]">
            <span>
              {m.git_commit_refused_source_conflict({ title: refusal.title })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChooseVersion(refusal)}
            >
              {m.git_commit_refused_choose_version()}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {save.error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
            <span>
              {save.error.outcome === "partial"
                ? m.changes_partial()
                : m.changes_save_failed()}
            </span>
            <span>{gitSaveErrorDescription(save.error)}</span>
          </AlertDescription>
        </Alert>
      ) : null}
      {!save.editable ? (
        <p className="text-sm text-muted-foreground">
          {save.access.loading || save.access.verifying
            ? m.changes_access_pending()
            : repositoryAccessPresentation(save.access).description}
        </p>
      ) : null}
      <RepositoryAccessInlineRecovery recovery={save.recovery} />
      <RepositoryAccessPrimaryButton recovery={save.recovery} />
      <Button
        disabled={!save.editable || save.saving || statusError}
        onClick={() => void save.save(!fileScope)}
      >
        {save.saving ? (
          <LoaderCircle className="animate-spin" data-icon="inline-start" />
        ) : null}
        {fileScope ? m.changes_save() : m.changes_save_all()}
        <span className="ml-auto">{hint}</span>
      </Button>
    </SheetFooter>
  );
}
