import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw } from "lucide-react";
import * as m from "@/paraglide/messages.js";

function platformInstructions() {
  return [
    { id: "macos", label: "macOS", text: m.git_missing_instructions_macos() },
    { id: "windows", label: "Windows", text: m.git_missing_instructions_windows() },
    { id: "linux", label: "Linux", text: m.git_missing_instructions_linux() },
  ];
}

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

interface GitMissingDialogProps {
  open: boolean;
  onRecheck: () => Promise<void>;
}

export function GitMissingDialog({ open, onRecheck }: GitMissingDialogProps) {
  const [checking, setChecking] = useState(false);
  const [platform] = useState(detectPlatform);
  const platforms = platformInstructions();

  async function recheck() {
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      setChecking(false);
    }
  }

  // No "skip" — dialog blocks until git is found.
  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-[520px]"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{m.git_missing_title()}</DialogTitle>
          <DialogDescription>{m.git_missing_description()}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={platform} className="mt-2">
          <TabsList>
            {platforms.map((p) => (
              <TabsTrigger key={p.id} value={p.id}>
                {p.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {platforms.map((p) => (
            <TabsContent key={p.id} value={p.id}>
              <pre className="text-xs font-mono bg-muted/50 rounded p-3 whitespace-pre-wrap">
                {p.text}
              </pre>
            </TabsContent>
          ))}
        </Tabs>
        <DialogFooter>
          <Button onClick={recheck} disabled={checking}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${checking ? "animate-spin" : ""}`}
            />
            {m.git_missing_recheck()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
