import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/lib/utils";

export function SettingsPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Each section opens at its top instead of the previous section's offset.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [title]);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-12 shrink-0 items-center border-b px-6 py-2 pr-12">
        <h2 className="truncate text-base font-medium" title={title}>
          {title}
        </h2>
      </header>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div className="flex w-full max-w-3xl min-w-0 flex-col gap-8 p-6">
          {children}
        </div>
      </div>
    </main>
  );
}

// Groups inside an owner block sit one heading level below the owner.
const SettingsHeadingLevel = createContext<3 | 4>(3);

export function SettingsOwnerBlock({
  icon,
  title,
  badges,
  summary,
  collapsible,
  headingRef,
  children,
  className,
  ...props
}: {
  icon?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  summary?: ReactNode;
  collapsible?: { open: boolean; onOpenChange(open: boolean): void };
  // Receives the focusable heading: the collapse trigger or the heading.
  headingRef?: (node: HTMLElement | null) => void;
  children?: ReactNode;
} & Omit<ComponentProps<"section">, "title" | "children">) {
  const titleId = useId();
  const header = (
    <>
      {icon ? (
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center text-base leading-none"
        >
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            id={titleId}
            className="min-w-0 text-base font-semibold wrap-break-word"
          >
            {title}
          </span>
          {badges}
        </span>
        {summary ? (
          <span className="text-sm font-normal text-muted-foreground wrap-break-word">
            {summary}
          </span>
        ) : null}
      </span>
    </>
  );
  const body = (
    <SettingsHeadingLevel value={4}>{children}</SettingsHeadingLevel>
  );
  const blockClassName = cn("flex min-w-0 flex-col gap-4", className);
  if (!collapsible)
    return (
      <section aria-labelledby={titleId} className={blockClassName} {...props}>
        <h3
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="flex min-w-0 scroll-mt-6 items-start gap-3 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {header}
        </h3>
        {body}
      </section>
    );
  return (
    <Collapsible
      asChild
      open={collapsible.open}
      onOpenChange={collapsible.onOpenChange}
    >
      <section aria-labelledby={titleId} className={blockClassName} {...props}>
        <h3 className="min-w-0">
          <CollapsibleTrigger
            ref={headingRef}
            className="group/owner flex w-full min-w-0 scroll-mt-6 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {header}
            <ChevronDown
              aria-hidden
              className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/owner:rotate-180"
            />
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent className="flex min-w-0 flex-col gap-4">
          {body}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function SettingsGroup({
  title,
  description,
  action,
  callout,
  children,
  className,
  ...props
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  callout?: ReactNode;
  children?: ReactNode;
} & Omit<ComponentProps<"section">, "title" | "children">) {
  const titleId = useId();
  const level = useContext(SettingsHeadingLevel);
  const Heading = level === 4 ? "h4" : "h3";
  const rows = Children.toArray(children);
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={cn("flex min-w-0 flex-col gap-3", className)}
      {...props}
    >
      {title || description || action ? (
        <div
          className={cn(
            "flex min-w-0 flex-wrap gap-x-4 gap-y-2",
            description ? "items-start" : "items-center",
          )}
        >
          {title || description ? (
            <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
              {title ? (
                <Heading
                  id={titleId}
                  className={cn(
                    "font-medium wrap-break-word",
                    level === 4 ? "text-sm" : "text-base",
                  )}
                >
                  {title}
                </Heading>
              ) : null}
              {description ? (
                <p className="text-sm text-muted-foreground wrap-break-word">
                  {description}
                </p>
              ) : null}
            </div>
          ) : null}
          {action ? (
            <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
              {action}
            </div>
          ) : null}
        </div>
      ) : null}
      {callout}
      {rows.length ? (
        <Card className="gap-0 py-0">
          <SettingsRows>{rows}</SettingsRows>
        </Card>
      ) : null}
    </section>
  );
}

// Rows of one card, or of one expanded row, separated by lines.
export function SettingsRows({ children }: { children: ReactNode }) {
  return Children.toArray(children).map((row, index) => (
    <Fragment key={isValidElement(row) ? (row.key ?? index) : index}>
      {index > 0 ? <Separator /> : null}
      {row}
    </Fragment>
  ));
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  error,
  errorId,
  layout = "inline",
  children,
  className,
  ...props
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  error?: ReactNode;
  errorId?: string;
  layout?: "inline" | "stacked";
  children: ReactNode;
} & Omit<ComponentProps<typeof Field>, "orientation" | "children">) {
  const stacked = layout === "stacked";
  return (
    <Field
      orientation={stacked ? "vertical" : "horizontal"}
      data-invalid={error ? true : undefined}
      className={cn(
        "px-4 py-3",
        !stacked &&
          "flex-wrap gap-x-6 gap-y-2 has-[>[data-slot=field-content]]:items-center",
        className,
      )}
      {...props}
    >
      <FieldContent className={cn(!stacked && "min-w-0 flex-[1_1_12rem]")}>
        {htmlFor ? (
          <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        ) : (
          <FieldTitle>{label}</FieldTitle>
        )}
        {description ? (
          <FieldDescription>{description}</FieldDescription>
        ) : null}
      </FieldContent>
      {stacked ? (
        children
      ) : (
        <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
          {children}
        </div>
      )}
      {error ? (
        <FieldError id={errorId} className={cn(!stacked && "basis-full")}>
          {error}
        </FieldError>
      ) : null}
    </Field>
  );
}

export function SettingsItem({
  media,
  title,
  description,
  actions,
  children,
  className,
  ...props
}: {
  media?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
} & Omit<ComponentProps<typeof Item>, "title" | "children">) {
  return (
    <Item
      className={cn(
        "min-w-0 rounded-none border-0 gap-x-6 gap-y-2 px-4 py-3",
        className,
      )}
      {...props}
    >
      {media ? <ItemMedia className="-mr-3">{media}</ItemMedia> : null}
      <ItemContent className="min-w-0 flex-[1_1_12rem]">
        <ItemTitle className="wrap-break-word">{title}</ItemTitle>
        {description ? (
          <ItemDescription className="line-clamp-none wrap-break-word">
            {description}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {actions ? (
        <ItemActions className="max-w-full min-w-0 flex-wrap">
          {actions}
        </ItemActions>
      ) : null}
      {children}
    </Item>
  );
}

// Shows or hides the stacked output of a row wrapped in a Collapsible.
export function SettingsDisclosureTrigger({
  open,
  label,
}: {
  open: boolean;
  label: string;
}) {
  return (
    <CollapsibleTrigger asChild>
      <Button variant="ghost" size="sm">
        {label}
        <ChevronDown
          data-icon="inline-end"
          className={cn("transition-transform", open && "rotate-180")}
        />
      </Button>
    </CollapsibleTrigger>
  );
}

export function SettingsActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export function SettingsRowSkeleton() {
  return (
    <div aria-hidden className="flex items-center gap-6 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-56 max-w-full" />
      </div>
      <Skeleton className="h-5 w-9" />
    </div>
  );
}
