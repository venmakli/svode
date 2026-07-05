import { useCallback, useEffect, useRef } from "react";
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
interface FitRequestOptions {
  focus?: boolean;
  scrollToBottom?: boolean;
}

const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const STABILIZED_FIT_DELAYS_MS = [50, 150];

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
  const fitFrameRef = useRef<number | null>(null);
  const fitTimerRefs = useRef<number[]>([]);
  const pendingFitOptionsRef = useRef<Required<FitRequestOptions>>({
    focus: false,
    scrollToBottom: false,
  });
  const firstWriteParsedFitRef = useRef(false);

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

  const fitTerminal = useCallback((options: FitRequestOptions = {}) => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal) return;
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;

    fitAddon.fit();
    if (options.scrollToBottom) terminal.scrollToBottom();
    if (options.focus && activeRef.current && panelOpenRef.current) {
      terminal.focus();
    }
  }, []);

  const requestTerminalFit = useCallback(
    (options: FitRequestOptions = {}) => {
      pendingFitOptionsRef.current = {
        focus: pendingFitOptionsRef.current.focus || Boolean(options.focus),
        scrollToBottom:
          pendingFitOptionsRef.current.scrollToBottom ||
          Boolean(options.scrollToBottom),
      };

      if (fitFrameRef.current !== null) return;
      fitFrameRef.current = window.requestAnimationFrame(() => {
        fitFrameRef.current = null;
        const nextOptions = pendingFitOptionsRef.current;
        pendingFitOptionsRef.current = {
          focus: false,
          scrollToBottom: false,
        };
        fitTerminal(nextOptions);
      });
    },
    [fitTerminal],
  );

  const scheduleStabilizedFit = useCallback(
    (options: FitRequestOptions = {}) => {
      requestTerminalFit(options);
      STABILIZED_FIT_DELAYS_MS.forEach((delay) => {
        const timerId = window.setTimeout(() => {
          requestTerminalFit(options);
        }, delay);
        fitTimerRefs.current.push(timerId);
      });
    },
    [requestTerminalFit],
  );

  const cancelPendingFits = useCallback(() => {
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    }
    fitTimerRefs.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    fitTimerRefs.current = [];
    pendingFitOptionsRef.current = { focus: false, scrollToBottom: false };
  }, []);

  useEffect(() => cancelPendingFits, [cancelPendingFits]);

  useEffect(() => {
    if (!terminalVisible) return;
    const container = containerRef.current;
    if (!container || terminalRef.current) return;
    firstWriteParsedFitRef.current = false;

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
      terminal.onWriteParsed(() => {
        if (firstWriteParsedFitRef.current) return;
        firstWriteParsedFitRef.current = true;
        scheduleStabilizedFit({ scrollToBottom: true });
      }),
    ];

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    scheduleStabilizedFit({
      focus: true,
      scrollToBottom: true,
    });

    return () => {
      cancelPendingFits();
      disposables.forEach((disposable) => disposable.dispose());
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [cancelPendingFits, scheduleStabilizedFit, terminalVisible]);

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
    scheduleStabilizedFit({
      focus: true,
      scrollToBottom: true,
    });
  }, [active, panelOpen, scheduleStabilizedFit]);

  useEffect(() => {
    if (!active || !panelOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      requestTerminalFit({ scrollToBottom: true });
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [active, panelOpen, requestTerminalFit]);

  return { containerRef, terminalVisible };
}
