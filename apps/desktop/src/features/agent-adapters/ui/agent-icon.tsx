import { cn } from "@/shared/lib/utils";
import { useAgentAdapterDictionary } from "../hooks/use-agent-adapter-dictionary";

/**
 * An agent's icon from the one agent dictionary: its brand icon, or the
 * first letter of its name. Decorative; the agent's name is said nearby.
 */
export function AgentIcon({
  agent,
  className,
}: {
  agent: string;
  className?: string;
}) {
  const icon = useAgentAdapterDictionary().icon(agent);
  if (icon.kind === "letter") {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[0.625rem] leading-none font-semibold text-muted-foreground",
          className,
        )}
      >
        {icon.letter}
      </span>
    );
  }
  if (icon.colored) {
    return (
      <img
        aria-hidden
        alt=""
        src={icon.src}
        draggable={false}
        className={cn("size-4 shrink-0", className)}
      />
    );
  }
  // A monochrome icon follows the text color.
  return (
    <span
      aria-hidden
      className={cn("inline-block size-4 shrink-0 bg-current", className)}
      style={{
        maskImage: `url("${icon.src}")`,
        maskRepeat: "no-repeat",
        maskSize: "contain",
        maskPosition: "center",
      }}
    />
  );
}
