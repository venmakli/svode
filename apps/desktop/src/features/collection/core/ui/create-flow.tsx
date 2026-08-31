import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

export type CollectionCreateFlowFocusTarget = "control" | "heading";

export interface CollectionCreateFlowFocusRequest {
  id: number;
  target: CollectionCreateFlowFocusTarget;
}

export interface CollectionCreateFlowAction {
  disabled?: boolean;
  form?: string;
  label: ReactNode;
  onClick?(): void;
  pending?: boolean;
  pendingLabel?: ReactNode;
}

export interface CollectionCreateFlowDiscardConfirmation {
  cancelLabel: ReactNode;
  confirmLabel: ReactNode;
  description: ReactNode;
  title: ReactNode;
}

export interface CollectionCreateFlowProps {
  backAction?: {
    label: ReactNode;
    onClick(): void;
  };
  cancelLabel: ReactNode;
  children: ReactNode;
  currentStep: number;
  dirty: boolean;
  discardConfirmation: CollectionCreateFlowDiscardConfirmation;
  flowId: string;
  focusRequest: CollectionCreateFlowFocusRequest;
  getControlFocusTarget?(
    content: HTMLDivElement,
    stepKey: string,
  ): HTMLElement | null;
  locked: boolean;
  modal?: boolean;
  primaryAction: CollectionCreateFlowAction;
  progressLabel: string;
  stepKey: string;
  stepLabel: ReactNode;
  title: ReactNode;
  totalSteps: number;
  onClose(): void;
}

export function CollectionCreateFlow({
  backAction,
  cancelLabel,
  children,
  currentStep,
  dirty,
  discardConfirmation,
  flowId,
  focusRequest,
  getControlFocusTarget,
  locked,
  modal,
  primaryAction,
  progressLabel,
  stepKey,
  stepLabel,
  title,
  totalSteps,
  onClose,
}: CollectionCreateFlowProps) {
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    const content = contentRef.current;
    const control =
      focusRequest.target === "control" && content
        ? getControlFocusTarget?.(content, stepKey)
        : null;
    (control ?? headingRef.current)?.focus();
  }, [focusRequest.id, focusRequest.target, getControlFocusTarget, stepKey]);

  const close = () => {
    const returnFocusTarget = returnFocusRef.current;
    onClose();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
      });
    }
  };
  const requestClose = () => {
    if (locked) return;
    if (!dirty) {
      close();
      return;
    }
    setDiscardOpen(true);
  };
  const primaryLabel =
    primaryAction.pending && primaryAction.pendingLabel
      ? primaryAction.pendingLabel
      : primaryAction.label;

  return (
    <>
      <Dialog
        open
        modal={modal}
        onOpenChange={(open) => !open && requestClose()}
      >
        <DialogContent
          ref={contentRef}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
          data-collection-core-create-flow={flowId}
          data-collection-core-create-step={stepKey}
          showCloseButton={!locked}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{progressLabel}</DialogDescription>
            <Progress
              value={(currentStep / totalSteps) * 100}
              aria-label={progressLabel}
              aria-valuemax={totalSteps}
              aria-valuemin={1}
              aria-valuenow={currentStep}
            />
          </DialogHeader>

          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1"
            data-collection-core-create-scroll-owner
          >
            <h2
              ref={headingRef}
              className="mb-4 text-base font-medium outline-none"
              data-collection-core-create-step-heading
              tabIndex={-1}
            >
              {stepLabel}
            </h2>
            {children}
          </div>

          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={requestClose}
            >
              {cancelLabel}
            </Button>
            {backAction ? (
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={backAction.onClick}
              >
                {backAction.label}
              </Button>
            ) : null}
            <Button
              type={primaryAction.form ? "submit" : "button"}
              form={primaryAction.form}
              disabled={locked || primaryAction.disabled}
              onClick={primaryAction.onClick}
            >
              {primaryAction.pending ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {primaryLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{discardConfirmation.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {discardConfirmation.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {discardConfirmation.cancelLabel}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={close}>
              {discardConfirmation.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
