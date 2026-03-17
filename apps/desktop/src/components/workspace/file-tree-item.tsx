import { useState } from "react";
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { useLayoutStore } from "@/stores/layout";
import type { TreeNode } from "@/types/workspace";

interface FileTreeItemProps {
  node: TreeNode;
}

export function FileTreeItem({ node }: FileTreeItemProps) {
  const { openDocument, activeDocument } = useLayoutStore();
  const [isOpen, setIsOpen] = useState(false);

  if (node.type === "Page") {
    const displayName = node.name.replace(/\.md$/, "");
    const isActive = activeDocument === node.path;

    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          isActive={isActive}
          onClick={() => openDocument(node.path)}
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{displayName}</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuSubItem>
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="group/collapsible">
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton>
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
            <Folder className="h-4 w-4 shrink-0" />
            <span className="truncate">{node.name}</span>
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <FileTreeItem key={child.path} node={child} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuSubItem>
  );
}
