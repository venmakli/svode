import { Bot } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/shared/lib/utils";

const ICON_SIZE = {
  default: "size-4",
  lg: "size-5",
  sm: "size-3.5",
} as const;

export function AgentAvatar({
  shape = "circle",
  size = "default",
  tone = "neutral",
}: {
  shape?: "circle" | "square";
  size?: "default" | "sm" | "lg";
  tone?: "neutral" | "destructive";
}) {
  return (
    <Avatar
      aria-hidden
      data-agent-avatar={tone}
      className={cn(shape === "square" && "rounded-lg after:rounded-lg")}
      size={size}
    >
      <AvatarFallback
        className={cn(
          shape === "square" && "rounded-lg",
          tone === "destructive" && "bg-destructive/10 text-destructive",
        )}
      >
        <Bot className={ICON_SIZE[size]} />
      </AvatarFallback>
    </Avatar>
  );
}
