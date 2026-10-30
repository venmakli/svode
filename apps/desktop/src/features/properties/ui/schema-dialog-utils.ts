export interface BaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}
