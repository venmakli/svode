import { AlertTriangle, Clock, Play, Zap } from "lucide-react";

import type { RoutineRow } from "../model/types";

export function RoutineTriggerIcon({
  className,
  row,
}: {
  className?: string;
  row: RoutineRow;
}) {
  if (!row.valid) return <AlertTriangle className={className} />;
  const type = row.definition?.trigger.type;
  if (type === "schedule") return <Clock className={className} />;
  if (type === "event") return <Zap className={className} />;
  return <Play className={className} />;
}
