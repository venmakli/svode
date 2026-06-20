import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

interface SpaceHealthSectionProps {
  brokenLinksCount: number | null;
  loading: boolean;
  onRefresh: () => void;
}

export function SpaceHealthSection({
  brokenLinksCount,
  loading,
  onRefresh,
}: SpaceHealthSectionProps) {
  return (
    <div className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label>{m.settings_health_broken_links()}</Label>
        <p className="text-sm text-muted-foreground">
          {m.settings_health_broken_links_desc()}
        </p>
      </div>
      <div className="flex items-center justify-between rounded-md border p-3">
        <span className="text-sm">
          {brokenLinksCount === null
            ? m.common_loading()
            : m.settings_health_broken_links_count({
                count: String(brokenLinksCount),
              })}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {m.settings_space_cli_refresh()}
        </Button>
      </div>
    </div>
  );
}
