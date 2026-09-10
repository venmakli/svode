import { useRef, type ComponentProps } from "react";
import { UserSettingsMenu } from "@/features/settings";
import { DogfoodUpdateDownloadButton } from "@/features/updates";

export function UserSettingsFooter(
  props: Omit<ComponentProps<typeof UserSettingsMenu>, "triggerRef">,
) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <UserSettingsMenu {...props} triggerRef={triggerRef} />
      <DogfoodUpdateDownloadButton returnFocusRef={triggerRef} />
    </div>
  );
}
