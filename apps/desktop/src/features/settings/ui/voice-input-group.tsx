import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import {
  activateSpeechModel,
  activeModelJob,
  AUTO_LANGUAGE,
  cancelSpeechModel,
  deleteSpeechModel,
  installedModels,
  installSpeechModel,
  isInstalled,
  megabytes,
  prepareSpeechModel,
  setSpeechLanguage,
  slowerModelOffer,
  speechLanguageChoice,
  useSpeechModels,
  type InstalledModelView,
  type SpeechJobDto,
  type SpeechLanguageDto,
  type SpeechModelDto,
  type SpeechModelsDto,
} from "@/features/voice-input";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRow,
  SettingsRowSkeleton,
  SettingsRows,
} from "./settings-layout";
import { SettingsSelect, type SettingsSelectOption } from "./settings-select";

const ignore = () => undefined;

/**
 * "Голосовой ввод" of App Settings "Сессии" (Stage 10 `06`): the model of
 * the release catalog with the recommendation for this device, the speech
 * language of that model and the installed models. A model is downloaded
 * only after its size is confirmed; removing the active one is confirmed
 * too, since dictation stops until another is chosen.
 */
export function VoiceInputGroup() {
  const models = useSpeechModels();
  const [download, setDownload] = useState<SpeechModelDto | null>(null);
  const [removal, setRemoval] = useState<InstalledModelView | null>(null);
  const active = models?.models.find((model) => model.id === models.activeModel);
  const installed = models ? installedModels(models) : null;

  return (
    <>
      <SettingsGroup
        title={m.voice_input_title()}
        description={m.voice_input_on_device()}
      >
        {models && installed ? (
          [
            <ModelRow key="model" models={models} onDownload={setDownload} />,
            active ? (
              <LanguageRow key="language" model={active} language={models.language} />
            ) : null,
            installed.models.length ? (
              <InstalledModels
                key="installed"
                models={installed.models}
                size={installed.size}
                onRemove={(model) =>
                  model.active ? setRemoval(model) : void deleteSpeechModel(model.id).catch(ignore)
                }
              />
            ) : null,
          ]
        ) : (
          <SettingsRowSkeleton />
        )}
      </SettingsGroup>

      <AlertDialog
        open={download !== null}
        onOpenChange={(open) => {
          if (!open) setDownload(null);
        }}
      >
        <AlertDialogContent data-voice-model-download>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.voice_input_settings_download_title({ name: download?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.voice_input_settings_download_description({
                size: megabytes(download?.size ?? 0),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.settings_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (download) void installSpeechModel(download.id).catch(ignore);
              }}
            >
              {m.voice_input_download({ size: megabytes(download?.size ?? 0) })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open) setRemoval(null);
        }}
      >
        <AlertDialogContent data-voice-model-remove>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.voice_input_settings_delete_title({ name: removal?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.voice_input_settings_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.settings_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removal) void deleteSpeechModel(removal.id).catch(ignore);
              }}
            >
              {m.voice_input_settings_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The select of the catalog. An installed model becomes active at once; a
 * model that is not installed asks to confirm its download. Below it: the
 * job of the active model or of the one being downloaded, else the V7
 * outcome when it suggests the fast model.
 */
function ModelRow({
  models,
  onDownload,
}: {
  models: SpeechModelsDto;
  onDownload: (model: SpeechModelDto) => void;
}) {
  const id = useId();
  const working = activeModelJob(models);
  const offer = slowerModelOffer(models);
  const options: SettingsSelectOption[] = models.models.map((model) => ({
    value: model.id,
    label: model.name,
    description: modelDescription(model, models.recommendation.modelId),
  }));
  const downloading =
    working !== null && !isInstalled(working.model) && working.job.stage !== "failed";
  return (
    <SettingsRow
      label={m.voice_input_settings_model()}
      htmlFor={id}
      footer={
        working ? (
          <JobLine model={working.model} job={working.job} />
        ) : offer ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm text-muted-foreground">{m.voice_input_slow()}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void (offer.installed
                  ? activateSpeechModel(offer.model.id)
                  : installSpeechModel(offer.model.id)
                ).catch(ignore)
              }
            >
              {offer.installed
                ? m.voice_input_choose_fast()
                : m.voice_input_download_fast({ size: megabytes(offer.model.size) })}
            </Button>
          </div>
        ) : null
      }
    >
      <SettingsSelect
        id={id}
        className="w-64"
        value={models.activeModel ?? ""}
        placeholder={m.voice_input_settings_no_model()}
        options={options}
        pending={downloading}
        onValueChange={(next) => {
          const model = models.models.find((candidate) => candidate.id === next);
          if (!model) return;
          if (isInstalled(model)) void activateSpeechModel(model.id).catch(ignore);
          else onDownload(model);
        }}
      />
    </SettingsRow>
  );
}

/** Size, languages and marks of a model in the select. */
function modelDescription(model: SpeechModelDto, recommended: string): string {
  const language = speechLanguageChoice(model);
  const parts = [
    m.voice_input_size({ size: megabytes(model.size) }),
    language.kind === "only"
      ? language.language === "ru"
        ? m.voice_input_settings_only_ru()
        : m.voice_input_settings_only_en()
      : language.options
          .filter((option) => option !== AUTO_LANGUAGE)
          .map((option) => languageLabel(option))
          .join(", "),
  ];
  if (model.id === recommended) parts.push(m.voice_input_settings_recommended());
  if (model.mark === "accurate") parts.push(m.voice_input_mark_accurate());
  if (model.mark === "fast") parts.push(m.voice_input_mark_fast());
  if (isInstalled(model)) parts.push(m.voice_input_settings_installed_mark());
  return parts.join(" · ");
}

function languageLabel(language: SpeechLanguageDto | typeof AUTO_LANGUAGE): string {
  switch (language) {
    case AUTO_LANGUAGE:
      return m.voice_input_language_auto();
    case "ru":
      return m.voice_input_language_ru();
    case "en":
      return m.voice_input_language_en();
  }
}

/** The languages of the active model only; one language is named, not chosen. */
function LanguageRow({
  model,
  language,
}: {
  model: SpeechModelDto;
  language: SpeechLanguageDto | null;
}) {
  const id = useId();
  const choice = speechLanguageChoice(model);
  if (choice.kind === "only") {
    return (
      <SettingsRow
        label={m.voice_input_settings_language()}
        description={m.voice_input_settings_language_only()}
        htmlFor={id}
      >
        <SettingsSelect
          id={id}
          value={choice.language}
          options={[{ value: choice.language, label: languageLabel(choice.language) }]}
          disabled
          onValueChange={ignore}
        />
      </SettingsRow>
    );
  }
  return (
    <SettingsRow label={m.voice_input_settings_language()} htmlFor={id}>
      <SettingsSelect
        id={id}
        value={language ?? AUTO_LANGUAGE}
        options={choice.options.map((option) => ({
          value: option,
          label: languageLabel(option),
        }))}
        onValueChange={(next) =>
          void setSpeechLanguage(
            next === AUTO_LANGUAGE ? null : (next as SpeechLanguageDto),
          ).catch(ignore)
        }
      />
    </SettingsRow>
  );
}

/** "Установленные модели (N, X ГБ)", collapsed: update and removal. */
function InstalledModels({
  models,
  size,
  onRemove,
}: {
  models: InstalledModelView[];
  size: number;
  onRemove: (model: InstalledModelView) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <SettingsItem
        title={m.voice_input_settings_installed({
          count: String(models.length),
          size: formatSize(size),
        })}
        actions={
          <SettingsDisclosureTrigger
            open={open}
            label={
              open
                ? m.voice_input_settings_installed_hide()
                : m.voice_input_settings_installed_show()
            }
          />
        }
      />
      <CollapsibleContent className="min-w-0 border-t bg-muted/40">
        <SettingsRows>
          {models.map((model) => (
            <InstalledModelRow
              key={model.id}
              model={model}
              onRemove={() => onRemove(model)}
            />
          ))}
        </SettingsRows>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InstalledModelRow({
  model,
  onRemove,
}: {
  model: InstalledModelView;
  onRemove: () => void;
}) {
  const entry = model.model;
  // The job of the active model shows in the "Модель" row.
  const job = model.active ? null : (entry?.job ?? null);
  const busy = entry?.job != null && entry.job.stage !== "failed";
  const facts = [formatSize(model.size)];
  if (model.installation === "outdated") facts.push(m.voice_input_settings_outdated());
  if (model.installation === "unsupported") facts.push(m.voice_input_settings_unsupported());
  return (
    <SettingsItem
      title={
        <>
          {model.name}
          {model.active ? (
            <Badge variant="secondary">{m.voice_input_settings_active()}</Badge>
          ) : null}
        </>
      }
      description={facts.join(" · ")}
      actions={
        <>
          {model.installation === "outdated" && entry ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void installSpeechModel(entry.id).catch(ignore)}
            >
              {m.voice_input_settings_update({ size: megabytes(entry.size) })}
            </Button>
          ) : null}
          <Button size="sm" variant="destructive" disabled={busy} onClick={onRemove}>
            {m.voice_input_settings_delete()}
          </Button>
        </>
      }
    >
      {job && entry ? (
        <div className="basis-full">
          <JobLine model={entry} job={job} />
        </div>
      ) : null}
    </SettingsItem>
  );
}

/** A download with its progress and cancel, a preparation or a failure. */
function JobLine({ model, job }: { model: SpeechModelDto; job: SpeechJobDto }) {
  switch (job.stage) {
    case "downloading":
      return (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Progress
            value={job.total > 0 ? (job.received / job.total) * 100 : 0}
            aria-label={m.voice_input_downloading()}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {model.name} ·{" "}
              {m.voice_input_download_progress({
                received: megabytes(job.received),
                total: megabytes(job.total),
              })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void cancelSpeechModel(model.id).catch(ignore)}
            >
              {m.voice_input_download_cancel()}
            </Button>
          </div>
        </div>
      );
    case "preparing":
      return (
        <p className="flex items-center gap-2 text-sm" aria-live="polite">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          {m.voice_input_preparing()}
        </p>
      );
    case "failed":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="alert">
          <p className="text-sm text-destructive">
            {job.failure === "network"
              ? m.voice_input_model_failed_network()
              : job.failure === "integrity"
                ? m.voice_input_model_failed_integrity()
                : job.failure === "disk"
                  ? m.voice_input_model_failed_disk()
                  : m.voice_input_model_failed_preparation()}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void (job.failure === "preparation"
                ? prepareSpeechModel(model.id)
                : installSpeechModel(model.id)
              ).catch(ignore)
            }
          >
            {m.voice_input_retry()}
          </Button>
        </div>
      );
  }
}

/** Megabytes below a gigabyte, gigabytes with one decimal above. */
function formatSize(bytes: number): string {
  if (bytes < 1_000_000_000) return m.voice_input_size({ size: megabytes(bytes) });
  const size = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(
    bytes / 1_000_000_000,
  );
  return m.voice_input_size_gb({ size });
}
