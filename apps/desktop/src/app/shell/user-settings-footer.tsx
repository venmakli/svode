import { useRef, type ComponentProps, type ReactNode } from "react";
import { UserSettingsMenu } from "@/features/settings";
import { DogfoodUpdateDownloadButton } from "@/features/updates";

export function UserSettingsFooter({
  actions,
  ...props
}: Omit<ComponentProps<typeof UserSettingsMenu>, "triggerRef"> & {
  /** Trailing controls after the update button, aligned to the right. */
  actions?: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <UserSettingsMenu {...props} triggerRef={triggerRef} />
      <DogfoodUpdateDownloadButton returnFocusRef={triggerRef} />
      {actions}
    </div>
  );
}
