import { MessageSquareOff } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import * as m from "@/paraglide/messages.js";
import { useHomeProjects } from "../hooks/use-home-projects";

/**
 * The main area of Home when no project can take a new chat: they are open
 * in other windows or unavailable.
 */
export function HomeChatUnavailable() {
  const { projects, availability } = useHomeProjects();
  const inOtherWindows = projects.filter(
    (project) => availability(project) === "otherWindow",
  ).length;
  const description =
    inOtherWindows === projects.length
      ? m.home_chat_no_project_other_windows()
      : inOtherWindows === 0
        ? m.home_chat_no_project_unavailable()
        : m.home_chat_no_project_mixed();

  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquareOff />
        </EmptyMedia>
        <EmptyTitle>{m.home_chat_no_project_title()}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
