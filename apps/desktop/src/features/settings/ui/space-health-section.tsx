import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./settings-layout";

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
    <SettingsGroup title={m.settings_health()}>
      <SettingsRow
        label={m.settings_health_broken_links()}
        description={m.settings_health_broken_links_desc()}
      >
        <span className="text-sm text-muted-foreground">
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
      </SettingsRow>
    </SettingsGroup>
  );
}
