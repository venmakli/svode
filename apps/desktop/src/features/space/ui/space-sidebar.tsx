import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";

import { useSpaceStore } from "../model";
import { NavDocuments } from "./nav-documents";
import { NavSpaces } from "./nav-spaces";
import { CreateSpaceDialog } from "./create-space-dialog";
import { useEffectiveIdentity } from "@/features/identity/use-effective-identity";
import { avatarColorFromEmail } from "@/features/identity/avatar-colors";
import * as m from "@/paraglide/messages.js";

interface SpaceSidebarProps {
  onOpenAppSettings: () => void;
  onOpenSpaceSettings: (spacePath: string) => void;
}

export function SpaceSidebar({
  onOpenAppSettings,
  onOpenSpaceSettings,
}: SpaceSidebarProps) {
  const navigate = useNavigate();
  const {
    rootSpaces,
    activeRootId,
    activeRootName,
    activeRootIcon,
    activeRootPath,
    openRoot,
    deleteRoot,
    goHome,
  } = useSpaceStore();
  const { name: identityName, email: identityEmail } = useEffectiveIdentity();

  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);

  const userName = identityName || "User";
  const userAvatar = avatarColorFromEmail(identityEmail);
  const initials = userName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  function handleGoHome() {
    goHome();
    navigate({ to: "/" });
  }

  function handleSwitchProject(id: string) {
    openRoot(id);
  }

  async function handleDeleteProject() {
    if (!activeRootId) return;
    await deleteRoot(activeRootId, deleteFiles);
    setDeleteOpen(false);
    setDeleteFiles(false);
    navigate({ to: "/" });
  }

  return (
    <Sidebar
      variant="floating"
      collapsible="offcanvas"
      className="pt-[44px] pr-0"
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="w-full">
                  <span className="mr-2">{activeRootIcon || "\u{1F4CB}"}</span>
                  <span className="font-medium truncate">
                    {activeRootName || "Project"}
                  </span>
                  <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
              >
                {activeRootPath && (
                  <DropdownMenuItem
                    onClick={() => onOpenSpaceSettings(activeRootPath)}
                  >
                    <Settings className="mr-2 h-4 w-4" />
                    {m.sidebar_project_settings()}
                  </DropdownMenuItem>
                )}
                {activeRootPath && (
                  <DropdownMenuItem onClick={() => setCreateWsOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    {m.sidebar_add_space()}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {rootSpaces.map((w) => (
                  <DropdownMenuItem
                    key={w.id}
                    onClick={() => handleSwitchProject(w.id)}
                  >
                    <span className="mr-2">{w.icon}</span>
                    <span className="flex-1 truncate">{w.name}</span>
                    {w.id === activeRootId && (
                      <Check className="ml-2 h-4 w-4" />
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleGoHome}>
                  {m.sidebar_all_projects()}
                </DropdownMenuItem>
                {activeRootId && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {m.sidebar_delete_project()}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavDocuments />
        <NavSpaces onOpenSpaceSettings={onOpenSpaceSettings} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="w-full"
              onClick={onOpenAppSettings}
            >
              <Avatar className="size-8 rounded-lg after:rounded-lg">
                <AvatarFallback
                  className="rounded-lg text-xs font-medium text-white"
                  style={{ backgroundColor: userAvatar }}
                >
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{userName}</span>
                <span className="truncate text-xs">{identityEmail ?? ""}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 opacity-50" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <CreateSpaceDialog open={createWsOpen} onOpenChange={setCreateWsOpen} />

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteOpen(false);
            setDeleteFiles(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.project_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.project_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 py-2 cursor-pointer">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <span className="text-sm text-destructive">
              {m.project_delete_files()}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteProject}
            >
              {m.project_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}
