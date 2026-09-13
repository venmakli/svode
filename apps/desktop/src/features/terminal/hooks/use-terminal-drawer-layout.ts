import { useRef, useState, type PointerEvent, type KeyboardEvent } from "react";
import { useTerminalStore } from "./use-terminal-store";

export function useTerminalDrawerLayout() {
  const [side, setSide] = useState<"right" | "bottom">("right");
  const [widthRatio, setWidthRatio] = useState(0.42);
  const heightRatio = useTerminalStore((state) => state.panelRatio);
  const setHeightRatio = useTerminalStore((state) => state.setPanelRatio);
  const drag = useRef<{
    pointerId: number;
    start: number;
    ratio: number;
    extent: number;
  } | null>(null);
  const ratio = side === "right" ? widthRatio : heightRatio;

  function setRatio(value: number) {
    const clamped = Math.min(0.72, Math.max(0.22, value));
    if (side === "right") setWidthRatio(clamped);
    else setHeightRatio(clamped);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      start: side === "right" ? event.clientX : event.clientY,
      ratio,
      extent: (side === "right" ? window.innerWidth : window.innerHeight) - 24,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const current = side === "right" ? event.clientX : event.clientY;
    setRatio(start.ratio + (start.start - current) / start.extent);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const grow = side === "right" ? "ArrowLeft" : "ArrowUp";
    const shrink = side === "right" ? "ArrowRight" : "ArrowDown";
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    setRatio(ratio + (event.key === grow ? 0.02 : -0.02));
  }

  return {
    side,
    ratio,
    toggleSide: () =>
      setSide((current) => (current === "right" ? "bottom" : "right")),
    resizeHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: () => {
        drag.current = null;
      },
      onPointerCancel: () => {
        drag.current = null;
      },
      onLostPointerCapture: () => {
        drag.current = null;
      },
      onKeyDown,
    },
  };
}
