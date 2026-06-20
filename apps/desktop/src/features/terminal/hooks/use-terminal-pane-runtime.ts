import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  resizeTerminal,
  writeTerminal,
} from "@/features/terminal/api/terminal";
import { subscribeTerminalOutput } from "@/features/terminal/lib/output-bus";
import type { TerminalTab } from "@/features/terminal/model/types";

interface UseTerminalPaneRuntimeOptions {
  tab: TerminalTab;
  active: boolean;
  panelOpen: boolean;
}

type Disposable = { dispose: () => void };

const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

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

export function useTerminalPaneRuntime({
  tab,
  active,
  panelOpen,
}: UseTerminalPaneRuntimeOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(tab.ptyId);
  const activeRef = useRef(active);
  const panelOpenRef = useRef(panelOpen);

  useEffect(() => {
    ptyIdRef.current = tab.ptyId;
  }, [tab.ptyId]);

  useEffect(() => {
    activeRef.current = active;
    panelOpenRef.current = panelOpen;
  }, [active, panelOpen]);

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
    const writeInput = (data: string) => {
      const ptyId = ptyIdRef.current;
      if (!ptyId) return;
      void writeTerminal(ptyId, data).catch((error) => {
        console.warn("Failed to write terminal input:", error);
      });
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        writeInput(SHIFT_ENTER_SEQUENCE);
        return false;
      }

      return true;
    });

    const disposables: Disposable[] = [
      terminal.onData((data) => {
        writeInput(data);
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
      if (activeRef.current && panelOpenRef.current) terminal.focus();
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

  return { containerRef, terminalVisible };
}
