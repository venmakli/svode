import { useState } from "react";
import { Code2, ExternalLink, FolderOpen, SquareTerminal } from "lucide-react";

import { cn } from "@/shared/lib/utils";

import type { ExternalApp } from "../model/types";

interface ExternalAppIconProps {
  app: Pick<ExternalApp, "icon" | "kind"> | null;
  className?: string;
  "data-icon"?: "inline-start" | "inline-end";
}

/**
 * The OS icon of an installed application in a fixed-size slot; a symbol by
 * application kind only when the OS returned no usable icon.
 */
export function ExternalAppIcon({
  app,
  className,
  "data-icon": dataIcon,
}: ExternalAppIconProps) {
  const [brokenIcon, setBrokenIcon] = useState<string | null>(null);
  const slot = cn("size-4 shrink-0", className);

  if (app?.icon && app.icon !== brokenIcon) {
    return (
      <img
        src={app.icon}
        alt=""
        aria-hidden
        draggable={false}
        data-external-app-icon="os"
        data-icon={dataIcon}
        className={cn(slot, "object-contain")}
        onError={() => setBrokenIcon(app.icon)}
      />
    );
  }

  const fallback = {
    "aria-hidden": true,
    "data-external-app-icon": "fallback",
    "data-icon": dataIcon,
    className: slot,
  };
  switch (app?.kind) {
    case "editor":
      return <Code2 {...fallback} />;
    case "file_manager":
      return <FolderOpen {...fallback} />;
    case "terminal":
      return <SquareTerminal {...fallback} />;
    default:
      return <ExternalLink {...fallback} />;
  }
}
