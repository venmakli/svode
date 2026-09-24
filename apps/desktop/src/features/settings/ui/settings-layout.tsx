import {
  Children,
  Fragment,
  isValidElement,
  useId,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Card } from "@/components/ui/card";
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
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-12 shrink-0 items-center border-b px-6 py-2 pr-12">
        <h2 className="truncate text-base font-medium" title={title}>
          {title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="flex w-full max-w-3xl min-w-0 flex-col gap-8 p-6">
          {children}
        </div>
      </div>
    </main>
  );
}

export function SettingsGroup({
  title,
  description,
  callout,
  children,
  className,
  ...props
}: {
  title?: ReactNode;
  description?: ReactNode;
  callout?: ReactNode;
  children: ReactNode;
} & Omit<ComponentProps<"section">, "title" | "children">) {
  const titleId = useId();
  const rows = Children.toArray(children);
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={cn("flex min-w-0 flex-col gap-3", className)}
      {...props}
    >
      {title || description ? (
        <div className="flex min-w-0 flex-col gap-1">
          {title ? (
            <h3 id={titleId} className="text-base font-medium wrap-break-word">
              {title}
            </h3>
          ) : null}
          {description ? (
            <p className="text-sm text-muted-foreground wrap-break-word">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      {callout}
      <Card className="gap-0 py-0">
        {rows.map((row, index) => (
          <Fragment key={isValidElement(row) ? (row.key ?? index) : index}>
            {index > 0 ? <Separator /> : null}
            {row}
          </Fragment>
        ))}
      </Card>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  error,
  layout = "inline",
  children,
  className,
  ...props
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  error?: ReactNode;
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
        <FieldError className={cn(!stacked && "basis-full")}>
          {error}
        </FieldError>
      ) : null}
    </Field>
  );
}

export function SettingsItem({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: {
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
