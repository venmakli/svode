import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./settings-layout";

interface SpaceHealthSectionProps {
  brokenLinksCount: number | null;
  loading: boolean;
  failed: boolean;
  onRefresh: () => void;
}

export function SpaceHealthSection({
  brokenLinksCount,
  loading,
  failed,
  onRefresh,
}: SpaceHealthSectionProps) {
  return (
    <SettingsGroup
      title={m.settings_health()}
      callout={
        failed && !loading ? (
          <Alert>
            <AlertTitle>{m.settings_health_broken_links_failed()}</AlertTitle>
            <AlertDescription>
              {m.settings_health_broken_links_failed_description()}
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      <SettingsRow
        label={m.settings_health_broken_links()}
        description={m.settings_health_broken_links_desc()}
      >
        {brokenLinksCount !== null ? (
          <span className="text-sm text-muted-foreground">
            {m.settings_health_broken_links_count({
              count: String(brokenLinksCount),
            })}
          </span>
        ) : failed && !loading ? null : (
          <Skeleton aria-hidden className="h-4 w-16" />
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {m.settings_health_refresh()}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
