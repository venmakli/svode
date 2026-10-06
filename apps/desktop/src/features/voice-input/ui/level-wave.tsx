import { useSyncExternalStore } from "react";
import { levelHeight } from "../model/dictation";
import { WAVE_BARS, type LevelHistory } from "../model/levels";

/** The live level of the recording: the last two seconds, newest right. */
export function LevelWave({ levels }: { levels: LevelHistory }) {
  const recent = useSyncExternalStore(levels.subscribe, levels.snapshot);
  const bars = Array.from(
    { length: WAVE_BARS },
    (_, index) => recent[index - (WAVE_BARS - recent.length)],
  );
  return (
    <div
      aria-hidden="true"
      className="flex h-6 min-w-0 flex-1 items-center justify-end gap-0.5 overflow-hidden"
    >
      {bars.map((dbfs, index) => (
        <span
          key={index}
          className="w-0.5 shrink-0 rounded-full bg-foreground/70"
          style={{
            height: `${Math.max(8, (dbfs === undefined ? 0 : levelHeight(dbfs)) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}
