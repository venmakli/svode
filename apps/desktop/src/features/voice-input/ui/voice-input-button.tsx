import { Loader2, Mic } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroupButton } from "@/components/ui/input-group";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  activateSpeechModel,
  cancelSpeechModel,
  installSpeechModel,
  prepareSpeechModel,
  type SpeechModelDto,
  type SpeechModelsDto,
} from "../api";
import type { Dictation } from "../hooks/use-dictation";
import { useSpeechModels } from "../hooks/use-speech-models";
import {
  isInstalled,
  megabytes,
  slowerModelOffer,
  voiceModelState,
  type VoiceModelState,
} from "../model/models";
import { voiceSettingsOpener } from "../model/settings-opener";
import { dictationShortcutLabel } from "../model/shortcut";
import * as m from "@/paraglide/messages.js";

/**
 * The microphone of a composer (`06`): it records once a model is ready;
 * otherwise it opens the enable popover, which downloads and prepares the
 * model recommended for this device. While another composer records it
 * waits.
 */
export function VoiceInputButton({
  dictation,
  disabled,
}: {
  dictation: Dictation;
  disabled?: boolean;
}) {
  const models = useSpeechModels();
  const modelState = models ? voiceModelState(models) : null;
  const { enableOpen, setEnableOpen } = dictation;

  if (dictation.busyElsewhere) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            <InputGroupButton
              size="icon-sm"
              className="rounded-full"
              disabled
              aria-label={m.voice_input_busy()}
            >
              <Mic />
            </InputGroupButton>
          </span>
        </TooltipTrigger>
        <TooltipContent>{m.voice_input_busy()}</TooltipContent>
      </Tooltip>
    );
  }

  const ready = modelState === null || modelState.kind === "ready";
  const label = ready
    ? m.voice_input_start({ shortcut: dictationShortcutLabel() })
    : m.voice_input_title();
  return (
    <Popover modal open={enableOpen} onOpenChange={setEnableOpen}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <InputGroupButton
              size="icon-sm"
              className="rounded-full"
              aria-label={label}
              aria-haspopup={ready ? undefined : "dialog"}
              disabled={disabled || dictation.state.phase === "starting"}
              onClick={() => {
                if (ready && !enableOpen) dictation.start();
                else setEnableOpen(!enableOpen);
              }}
            >
              <ButtonIcon state={modelState} starting={dictation.state.phase === "starting"} />
            </InputGroupButton>
          </TooltipTrigger>
        </PopoverAnchor>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{m.voice_input_title()}</PopoverTitle>
          <PopoverDescription>{m.voice_input_on_device()}</PopoverDescription>
        </PopoverHeader>
        {models && modelState && (
          <EnableContent
            models={models}
            state={modelState}
            onClose={() => setEnableOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ButtonIcon({
  state,
  starting,
}: {
  state: VoiceModelState | null;
  starting: boolean;
}) {
  if (starting || state?.kind === "preparing") return <Loader2 className="animate-spin" />;
  if (state?.kind === "downloading") {
    return <ProgressRing value={state.total > 0 ? state.received / state.total : 0} />;
  }
  return <Mic />;
}

/** Download progress in place of the microphone icon. */
function ProgressRing({ value }: { value: number }) {
  const circumference = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-muted" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-primary"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, value))}
      />
    </svg>
  );
}

function EnableContent({
  models,
  state,
  onClose,
}: {
  models: SpeechModelsDto;
  state: VoiceModelState;
  onClose: () => void;
}) {
  const install = (id: string) => void installSpeechModel(id).catch(() => undefined);
  switch (state.kind) {
    case "missing": {
      const openSettings = voiceSettingsOpener();
      return (
        <div className="flex flex-col gap-3">
          <ModelLine model={state.model} />
          {isInstalled(state.model) ? (
            <Button
              size="sm"
              onClick={() => void activateSpeechModel(state.model.id).catch(() => undefined)}
            >
              {m.voice_input_use_model()}
            </Button>
          ) : (
            <Button size="sm" onClick={() => install(state.model.id)}>
              {m.voice_input_download({ size: megabytes(state.model.size) })}
            </Button>
          )}
          {openSettings && (
            <Button
              size="sm"
              variant="link"
              className="self-center"
              onClick={() => {
                onClose();
                openSettings();
              }}
            >
              {m.voice_input_other_models()}
            </Button>
          )}
        </div>
      );
    }
    case "downloading":
      return (
        <div className="flex flex-col gap-2" aria-live="polite">
          <ModelLine model={state.model} />
          <Progress
            value={state.total > 0 ? (state.received / state.total) * 100 : 0}
            aria-label={m.voice_input_downloading()}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {m.voice_input_download_progress({
                received: megabytes(state.received),
                total: megabytes(state.total),
              })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void cancelSpeechModel(state.model.id).catch(() => undefined)}
            >
              {m.voice_input_download_cancel()}
            </Button>
          </div>
        </div>
      );
    case "preparing":
      return (
        <div className="flex flex-col gap-2" aria-live="polite">
          <ModelLine model={state.model} />
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
            {m.voice_input_preparing()}
          </p>
          <p className="text-xs text-muted-foreground">{m.voice_input_preparing_hint()}</p>
        </div>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-3" role="alert">
          <ModelLine model={state.model} />
          <p className="text-xs text-destructive">
            {state.failure === "network"
              ? m.voice_input_model_failed_network()
              : state.failure === "integrity"
                ? m.voice_input_model_failed_integrity()
                : state.failure === "disk"
                  ? m.voice_input_model_failed_disk()
                  : m.voice_input_model_failed_preparation()}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              state.failure === "preparation"
                ? void prepareSpeechModel(state.model.id).catch(() => undefined)
                : install(state.model.id)
            }
          >
            {m.voice_input_retry()}
          </Button>
        </div>
      );
    case "ready":
      return <ReadyContent models={models} model={state.model} />;
  }
}

/** "Готово", with the V7 outcome when it suggests the fast model. */
function ReadyContent({
  models,
  model,
}: {
  models: SpeechModelsDto;
  model: SpeechModelDto;
}) {
  const offer = slowerModelOffer(models);
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <ModelLine model={model} />
      <p className="text-sm">{m.voice_input_ready({ shortcut: dictationShortcutLabel() })}</p>
      {offer && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{m.voice_input_slow()}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void (offer.installed
                ? activateSpeechModel(offer.model.id)
                : installSpeechModel(offer.model.id)
              ).catch(() => undefined)
            }
          >
            {offer.installed
              ? m.voice_input_choose_fast()
              : m.voice_input_download_fast({ size: megabytes(offer.model.size) })}
          </Button>
        </div>
      )}
    </div>
  );
}

function ModelLine({ model }: { model: SpeechModelDto }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="truncate font-medium">{model.name}</span>
      {model.mark && (
        <Badge variant="secondary">
          {model.mark === "accurate" ? m.voice_input_mark_accurate() : m.voice_input_mark_fast()}
        </Badge>
      )}
      <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {m.voice_input_size({ size: megabytes(model.size) })}
      </span>
    </div>
  );
}
