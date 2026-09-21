import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LfsPolicyDiagnostic } from "../api";

const VISIBLE_PATH_LIMIT = 5;

const DECLARATION_LABELS: Record<
  Exclude<NonNullable<LfsPolicyDiagnostic["lfsDeclaration"]>, "missing">,
  () => string
> = {
  published: m.storage_lfs_declaration_published,
  pending: m.storage_lfs_declaration_pending,
  foreign: m.storage_lfs_declaration_foreign,
};

interface StorageLfsPolicyWarningProps {
  diagnostic: LfsPolicyDiagnostic | null;
  loading: boolean;
  error: boolean;
  updating: boolean;
  canUpdate: boolean;
  onUpdate: () => void;
  onRefresh: () => void;
}

export function StorageLfsPolicyWarning({
  diagnostic,
  loading,
  error,
  updating,
  canUpdate,
  onUpdate,
  onRefresh,
}: StorageLfsPolicyWarningProps) {
  const uncoveredCount =
    (diagnostic?.uncoveredPaths.length ?? 0) +
    (diagnostic?.truncatedCount ?? 0);
  const policyStale = diagnostic?.managedPolicyCurrent === false;
  const declaration = diagnostic?.lfsDeclaration ?? null;
  const declarationMissing = declaration === "missing";
  const declarationStatus =
    declaration && declaration !== "missing" ? (
      <p className="text-xs text-muted-foreground">
        {m.storage_lfs_declaration_status({
          state: DECLARATION_LABELS[declaration](),
        })}
      </p>
    ) : null;

  if (!error && !policyStale && uncoveredCount === 0 && !declarationMissing) {
    return declarationStatus;
  }

  const visiblePaths =
    diagnostic?.uncoveredPaths.slice(0, VISIBLE_PATH_LIMIT) ?? [];
  const hiddenCount = Math.max(0, uncoveredCount - visiblePaths.length);

  const alert = (
    <Alert>
      <TriangleAlert />
      <AlertTitle>
        {error
          ? m.storage_lfs_policy_error_title()
          : policyStale
            ? m.storage_lfs_policy_update_title()
            : uncoveredCount > 0
              ? m.storage_lfs_policy_uncovered_title({
                  count: String(uncoveredCount),
                })
              : m.storage_lfs_declaration_missing_title()}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        {error && <span>{m.storage_lfs_policy_error_description()}</span>}
        {policyStale && (
          <span>{m.storage_lfs_policy_update_description()}</span>
        )}
        {declarationMissing && (
          <span>{m.storage_lfs_declaration_missing_description()}</span>
        )}
        {uncoveredCount > 0 && (
          <>
            <span>{m.storage_lfs_policy_uncovered_description()}</span>
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {visiblePaths.map((path) => (
                <li key={path} className="break-all">
                  {path}
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <span>
                {m.storage_lfs_policy_more({ count: String(hiddenCount) })}
              </span>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {(policyStale || declarationMissing) && (
            <Button
              type="button"
              size="sm"
              onClick={onUpdate}
              disabled={!canUpdate || loading}
              aria-busy={updating}
            >
              {updating && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {m.storage_lfs_policy_update_action()}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={loading || updating}
            aria-busy={loading}
          >
            <RefreshCw
              data-icon="inline-start"
              className={loading ? "animate-spin" : undefined}
            />
            {m.storage_lfs_policy_refresh_action()}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );

  if (!declarationStatus) return alert;
  return (
    <div className="flex flex-col gap-2">
      {alert}
      {declarationStatus}
    </div>
  );
}
