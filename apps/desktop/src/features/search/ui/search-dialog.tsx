import { useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const SEARCH_DIALOG_CLASS_NAME =
  "h-[min(480px,calc(100vh-2rem))] w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 md:max-w-[700px] lg:max-w-[800px]";

export function SearchDialog({
  children,
  description,
  open,
  title,
  onOpenChange,
}: {
  children: ReactNode;
  description: string;
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  const restoreFocus = () => {
    const target = returnFocusRef.current;
    if (!target?.isConnected) return;
    target.focus();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen && typeof window !== "undefined") {
          window.requestAnimationFrame(restoreFocus);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={SEARCH_DIALOG_CLASS_NAME}
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef.current?.isConnected) return;
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
