import { useEffect, useRef, useState } from "react";
import { useChatStatusStore } from "../model";
import { useSpaceStore } from "@/features/space";
import { cn } from "@/shared/lib/utils";

function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

const statusLabels: Record<string, string> = {
  idle: "idle",
  thinking: "thinking",
  writing: "writing",
  "tool-calling": "tool calling",
  "awaiting-permission": "awaiting permission",
};

export function ThreadStatusBar({ isRunning }: { isRunning: boolean }) {
  const agentStatus = useChatStatusStore((s) => s.agentStatus);
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId);
  const activeRootName = useSpaceStore((s) => s.activeRootName);
  const spaces = useSpaceStore((s) => s.spaces);
  const spaceName = activeSpaceId
    ? spaces.find((w) => w.id === activeSpaceId)?.name
    : activeRootName;

  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (isRunning) {
      startRef.current = Date.now();
      queueMicrotask(() => {
        if (!cancelled) setElapsed(0);
      });
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - startRef.current);
      }, 500);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning]);

  return (
    <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span className="font-medium">Agent:</span>
        <span className="flex items-center gap-1">
          {isRunning && (
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full bg-emerald-500",
                "animate-pulse",
              )}
            />
          )}
          {statusLabels[agentStatus] ?? agentStatus}
        </span>
      </div>
      <span className="text-muted-foreground/50">&middot;</span>
      <span>claude</span>
      {spaceName && (
        <>
          <span className="text-muted-foreground/50">&middot;</span>
          <span className="truncate max-w-40" title={spaceName}>
            📁 {spaceName}
          </span>
        </>
      )}
      {isRunning && elapsed > 0 && (
        <>
          <span className="text-muted-foreground/50">&middot;</span>
          <span>elapsed: {formatMs(elapsed)}</span>
        </>
      )}
    </div>
  );
}
