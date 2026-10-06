import { useState } from "react";
import { ArrowUp, Copy, Loader2, Settings, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroupButton } from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { openSpeechSystemSettings } from "../api";
import type { Dictation } from "../hooks/use-dictation";
import type { DictationRowFailure } from "../model/dictation";
import { LevelWave } from "./level-wave";
import { RecordingClock } from "./recording-clock";
import * as m from "@/paraglide/messages.js";

/**
 * In place of the composer's bottom row while dictating (`04` view, `06`
 * states): ✕, the level wave, the time, ■ and ↑; then "Распознаётся…";
 * or a failure with its recovery. The draft above stays as it is.
 */
export function RecordingRow({
  dictation,
  canSend,
}: {
  dictation: Dictation;
  /** ↑ can send the draft once the text is in. */
  canSend: boolean;
}) {
  const { state } = dictation;
  const cancel = (
    <IconAction label={m.voice_input_cancel()} onClick={dictation.cancel}>
      <X />
    </IconAction>
  );
  if (state.phase === "recording") {
    return (
      <div className="flex w-full min-w-0 items-center gap-2" role="group" aria-label={m.voice_input_recording()}>
        {cancel}
        <LevelWave levels={dictation.levels} />
        <RecordingClock startedAt={state.startedAt} />
        <IconAction label={m.voice_input_stop()} onClick={() => dictation.finish(false)}>
          <Square />
        </IconAction>
        <IconAction
          label={m.voice_input_stop_and_send()}
          variant="default"
          disabled={!canSend}
          onClick={() => dictation.finish(true)}
        >
          <ArrowUp />
        </IconAction>
      </div>
    );
  }
  if (state.phase === "recognizing") {
    return (
      <div className="flex w-full min-w-0 items-center gap-2" role="status">
        {cancel}
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">{m.voice_input_recognizing()}</span>
      </div>
    );
  }
  if (state.phase === "failed") {
    return (
      <div className="flex w-full min-w-0 items-start gap-2" role="alert">
        {cancel}
        <FailureContent failure={state.failure} dictation={dictation} />
      </div>
    );
  }
  return null;
}

function FailureContent({
  failure,
  dictation,
}: {
  failure: DictationRowFailure;
  dictation: Dictation;
}) {
  switch (failure.code) {
    case "recognition":
      return (
        <FailureLine text={m.voice_input_failed_recognition()}>
          <Button size="xs" variant="outline" onClick={dictation.retry}>
            {m.voice_input_retry()}
          </Button>
        </FailureLine>
      );
    case "modelMissing":
      return (
        <FailureLine text={m.voice_input_failed_model()}>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              dictation.cancel();
              dictation.setEnableOpen(true);
            }}
          >
            {m.voice_input_enable()}
          </Button>
        </FailureLine>
      );
    case "denied":
      return <DeniedContent recovery={failure.recovery} />;
    case "noDevice":
      return <FailureLine text={m.voice_input_failed_no_device()} />;
    case "noSignal":
      return (
        <FailureLine
          text={m.voice_input_failed_no_signal()}
          hint={m.voice_input_failed_no_signal_hint()}
        >
          {failure.soundSettings && (
            <SettingsButton target="soundInput" label={m.voice_input_open_sound_settings()} />
          )}
        </FailureLine>
      );
    case "device":
      return <FailureLine text={m.voice_input_failed_device()} />;
  }
}

function DeniedContent({
  recovery,
}: {
  recovery: Extract<DictationRowFailure, { code: "denied" }>["recovery"];
}) {
  const [copied, setCopied] = useState(false);
  switch (recovery.kind) {
    case "resetCommand":
      return (
        <FailureLine
          text={m.voice_input_failed_denied()}
          hint={m.voice_input_failed_denied_macos()}
        >
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {recovery.command}
          </code>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                .writeText(recovery.command)
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            <Copy data-icon="inline-start" />
            {copied ? m.voice_input_copied() : m.voice_input_copy()}
          </Button>
        </FailureLine>
      );
    case "openSettings":
      return (
        <FailureLine text={m.voice_input_failed_denied()}>
          <SettingsButton target="microphonePrivacy" label={m.voice_input_open_privacy_settings()} />
        </FailureLine>
      );
    case "none":
      return (
        <FailureLine
          text={m.voice_input_failed_denied()}
          hint={m.voice_input_failed_denied_linux()}
        />
      );
  }
}

function FailureLine({
  text,
  hint,
  children,
}: {
  text: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
      <p className="text-xs text-destructive">{text}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function SettingsButton({
  target,
  label,
}: {
  target: "microphonePrivacy" | "soundInput";
  label: string;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => void openSpeechSystemSettings(target).catch(() => undefined)}
    >
      <Settings data-icon="inline-start" />
      {label}
    </Button>
  );
}

function IconAction({
  label,
  variant = "ghost",
  disabled,
  onClick,
  children,
}: {
  label: string;
  variant?: "ghost" | "default";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InputGroupButton
          size="icon-sm"
          variant={variant}
          className="shrink-0 rounded-full"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </InputGroupButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
