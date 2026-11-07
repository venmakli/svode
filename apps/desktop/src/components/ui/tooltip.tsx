import * as React from "react"
import { flushSync } from "react-dom"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/shared/lib/utils"

/** Whether the tooltip is closing on Esc, so its content leaves at once. */
const TooltipEscapeContext = React.createContext(false)

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/**
 * A tooltip never holds Esc. Radix gives Esc to the top layer only, and an
 * open tooltip is one, so the sheet, dialog or menu under it would need a
 * second press. An open tooltip therefore closes before the layers see the
 * key, without taking it, and the same Esc reaches the layer under it.
 */
function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const [closingOnEscape, setClosingOnEscape] = React.useState(false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : uncontrolledOpen
  const onOpenChangeRef = React.useRef(onOpenChange)
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) setClosingOnEscape(false)
      if (!controlled) setUncontrolledOpen(next)
      onOpenChangeRef.current?.(next)
    },
    [controlled]
  )

  React.useEffect(() => {
    if (!open) return
    // The window capture phase runs before the Esc listeners of the layers
    // on the document; the content unmounts synchronously, which takes the
    // tooltip off the layer stack before they compare their places.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return
      flushSync(() => {
        setClosingOnEscape(true)
        setOpen(false)
      })
    }
    window.addEventListener("keydown", closeOnEscape, true)
    return () => window.removeEventListener("keydown", closeOnEscape, true)
  }, [open, setOpen])

  return (
    <TooltipEscapeContext.Provider value={closingOnEscape}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </TooltipEscapeContext.Provider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  // Without the exit animation the content unmounts in the same render.
  const closingOnEscape = React.useContext(TooltipEscapeContext)
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          closingOnEscape && "animate-none!",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
