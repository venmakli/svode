import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/utils";
import { recordingClock } from "../model/dictation";
import * as m from "@/paraglide/messages.js";

/** The duration, then the countdown of the last ten seconds. */
export function RecordingClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const clock = recordingClock(now - startedAt);
  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums text-muted-foreground",
        clock.countdown && "font-medium text-destructive",
      )}
      title={clock.countdown ? m.voice_input_limit_soon() : undefined}
    >
      {clock.text}
    </span>
  );
}
