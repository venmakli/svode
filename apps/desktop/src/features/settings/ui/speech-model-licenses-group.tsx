import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import type { SpeechModelLicenseDto } from "../api";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRows,
} from "./settings-layout";

/**
 * Licenses and attribution of the voice input models: Svode ships none of
 * them, the user downloads them from the release catalog, and of the
 * reference recording the model preparation measures with.
 */
export function SpeechModelLicensesGroup({
  licenses,
}: {
  licenses: readonly SpeechModelLicenseDto[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsGroup
      title={m.settings_about_speech_title()}
      description={m.settings_about_speech_description()}
    >
      {licenses.length ? (
        <Collapsible
          key="models"
          open={open}
          onOpenChange={setOpen}
          className="min-w-0"
        >
          <SettingsItem
            title={m.settings_about_speech_models({
              count: String(licenses.length),
            })}
            actions={
              <SettingsDisclosureTrigger
                open={open}
                label={
                  open
                    ? m.settings_about_speech_models_hide()
                    : m.settings_about_speech_models_show()
                }
              />
            }
          />
          <CollapsibleContent className="min-w-0 border-t bg-muted/40">
            <SettingsRows>
              {licenses.map((model) => (
                <SettingsItem
                  key={model.id}
                  title={model.name}
                  description={m.settings_about_speech_model_source({
                    upstream: model.upstream,
                    repo: model.repo,
                  })}
                  actions={<LicenseLink license={model.license} />}
                />
              ))}
            </SettingsRows>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <SettingsItem
        key="reference"
        title={m.settings_about_speech_reference()}
        description={m.settings_about_speech_reference_description()}
      />
    </SettingsGroup>
  );
}

function LicenseLink({
  license,
}: {
  license: SpeechModelLicenseDto["license"];
}) {
  if (!license.link)
    return (
      <span className="text-sm text-muted-foreground">{license.name}</span>
    );
  return (
    <Button asChild variant="link" size="sm">
      <a href={license.link} target="_blank" rel="noopener noreferrer">
        {license.name}
        <ArrowUpRight data-icon="inline-end" />
      </a>
    </Button>
  );
}
