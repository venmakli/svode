import { AlertTriangle, Clock, Play, Zap } from "lucide-react";

import type { RoutineItem } from "../model/types";

export function RoutineTriggerIcon({
  className,
  item,
}: {
  className?: string;
  item: RoutineItem;
}) {
  if (!item.valid) return <AlertTriangle className={className} />;
  const type = item.definition?.trigger.type;
  if (type === "schedule") return <Clock className={className} />;
  if (type === "event") return <Zap className={className} />;
  return <Play className={className} />;
}
