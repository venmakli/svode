import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  resizeTerminal,
  writeTerminal,
} from "@/features/terminal/api/terminal";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import { subscribeTerminalOutput } from "@/features/terminal/lib/output-bus";
import type { TerminalTab } from "@/features/terminal/model/types";
import * as m from "@/paraglide/messages.js";

interface TerminalPaneProps {
  tab: TerminalTab;
  active: boolean;
  panelOpen: boolean;
}

type Disposable = { dispose: () => void };

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function terminalTheme() {
  return {
    background: readCssVar("--background"),
    foreground: readCssVar("--foreground"),
    cursor: readCssVar("--foreground"),
    selectionBackground: readCssVar("--accent"),
    selectionForeground: readCssVar("--accent-foreground"),
  };
}

export function TerminalPane({ tab, active, panelOpen }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(tab.ptyId);
  const closeTab = useTerminalStore((state) => state.closeTab);

  useEffect(() => {
    ptyIdRef.current = tab.ptyId;
  }, [tab.ptyId]);

  const terminalVisible =
    tab.status === "spawning" ||
    tab.status === "ready" ||
    tab.status === "exited";

  useEffect(() => {
    if (!terminalVisible) return;
    const container = containerRef.current;
    if (!container || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: false,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    const disposables: Disposable[] = [
      terminal.onData((data) => {
        const ptyId = ptyIdRef.current;
        if (!ptyId) return;
        void writeTerminal(ptyId, data).catch((error) => {
          console.warn("Failed to write terminal input:", error);
        });
      }),
      terminal.onBinary((data) => {
        const ptyId = ptyIdRef.current;
        if (!ptyId) return;
        void writeTerminal(ptyId, data).catch((error) => {
          console.warn("Failed to write terminal binary input:", error);
        });
      }),
      terminal.onResize(({ cols, rows }) => {
        const ptyId = ptyIdRef.current;
        if (!ptyId) return;
        void resizeTerminal(ptyId, cols, rows).catch((error) => {
          console.warn("Failed to resize terminal:", error);
        });
      }),
    ];

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    requestAnimationFrame(() => {
      fitAddon.fit();
      if (active && panelOpen) terminal.focus();
    });

    return () => {
      disposables.forEach((disposable) => disposable.dispose());
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalVisible]);

  useEffect(() => {
    if (!tab.ptyId) return;
    return subscribeTerminalOutput(tab.ptyId, (data) => {
      terminalRef.current?.write(data);
    });
  }, [tab.ptyId]);

  useEffect(() => {
    const updateTheme = () => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = terminalTheme();
      }
    };
    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || !panelOpen) return;
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });
  }, [active, panelOpen]);

  useEffect(() => {
    if (!active || !panelOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [active, panelOpen]);

  return (
    <div className={cn("absolute inset-0", active ? "block" : "hidden")}>
      {terminalVisible ? (
        <div className="relative h-full overflow-hidden">
          <div
            ref={containerRef}
            className="h-full overflow-hidden px-2 py-1"
          />
          {tab.status === "exited" && (
            <div className="pointer-events-none absolute right-3 bottom-2 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
              {m.terminal_session_exited()}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <div className="max-w-xl text-center">
            {tab.status === "exited"
              ? m.terminal_session_exited()
              : tab.error || m.terminal_spawn_error()}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void closeTab(tab.id)}
          >
            {m.terminal_close_tab()}
          </Button>
        </div>
      )}
    </div>
  );
}
