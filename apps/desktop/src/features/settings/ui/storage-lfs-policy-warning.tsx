import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LfsPolicyDiagnostic } from "../api";

const VISIBLE_PATH_LIMIT = 5;

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
  if (
    !error &&
    (!diagnostic ||
      (diagnostic.managedPolicyCurrent &&
        diagnostic.uncoveredPaths.length === 0))
  ) {
    return null;
  }

  const uncoveredCount =
    (diagnostic?.uncoveredPaths.length ?? 0) +
    (diagnostic?.truncatedCount ?? 0);
  const visiblePaths =
    diagnostic?.uncoveredPaths.slice(0, VISIBLE_PATH_LIMIT) ?? [];
  const hiddenCount = Math.max(0, uncoveredCount - visiblePaths.length);

  return (
    <Alert>
      <TriangleAlert />
      <AlertTitle>
        {error
          ? m.storage_lfs_policy_error_title()
          : diagnostic?.managedPolicyCurrent
            ? m.storage_lfs_policy_uncovered_title({
                count: String(uncoveredCount),
              })
            : m.storage_lfs_policy_update_title()}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        {error && <span>{m.storage_lfs_policy_error_description()}</span>}
        {diagnostic && !diagnostic.managedPolicyCurrent && (
          <span>{m.storage_lfs_policy_update_description()}</span>
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
          {diagnostic && !diagnostic.managedPolicyCurrent && (
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
}
