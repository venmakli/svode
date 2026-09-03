import { useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  MoveHorizontal,
  MoveVertical,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

import type { DocumentViewState, DocumentZoomMode } from "../model/types";

export function DocxToolbar({
  findMatches,
  fit,
  goToPage,
  navigateFind,
  onOpenExternal,
  onViewStateChange,
  pageCount,
  setZoom,
  title,
  toolbarActions,
  viewState,
}: {
  findMatches: number;
  fit(mode: Extract<DocumentZoomMode, "page" | "width">): void;
  goToPage(page: number): void;
  navigateFind(direction: 1 | -1): void;
  onOpenExternal(): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  pageCount: number;
  setZoom(zoom: number): void;
  title: string;
  toolbarActions?: ReactNode;
  viewState: DocumentViewState;
}) {
  const nextFitMode: Extract<DocumentZoomMode, "page" | "width"> =
    viewState.zoomMode === "width" ? "page" : "width";

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-hidden border-b bg-background px-2 py-2">
      <div
        className="min-w-0 flex-1 truncate px-1 text-sm font-medium"
        title={title}
      >
        {title}
      </div>
      <ButtonGroup className="shrink-0">
        <TooltipButton
          grouped
          label={m.document_previous_page()}
          disabled={viewState.pageNumber <= 1}
          onClick={() => goToPage(viewState.pageNumber - 1)}
        >
          <ChevronLeft />
        </TooltipButton>
        <PageNumberInput
          key={viewState.pageNumber}
          onPageChange={goToPage}
          pageNumber={viewState.pageNumber}
        />
        <ButtonGroupText className="h-7 rounded-none px-2 text-xs font-normal tabular-nums">
          {m.document_page_count({ count: String(pageCount) })}
        </ButtonGroupText>
        <TooltipButton
          grouped
          label={m.document_next_page()}
          disabled={viewState.pageNumber >= pageCount}
          onClick={() => goToPage(viewState.pageNumber + 1)}
        >
          <ChevronRight />
        </TooltipButton>
      </ButtonGroup>
      <ButtonGroup className="shrink-0">
        <TooltipButton
          grouped
          label={m.document_zoom_out()}
          onClick={() => setZoom(viewState.zoom - 0.1)}
        >
          <ZoomOut />
        </TooltipButton>
        <ButtonGroupText className="h-7 min-w-12 justify-center rounded-none px-2 text-xs font-normal tabular-nums">
          {Math.round(viewState.zoom * 100)}%
        </ButtonGroupText>
        <TooltipButton
          grouped
          label={m.document_zoom_in()}
          onClick={() => setZoom(viewState.zoom + 0.1)}
        >
          <ZoomIn />
        </TooltipButton>
      </ButtonGroup>
      <TooltipButton
        label={
          nextFitMode === "width"
            ? m.document_fit_width()
            : m.document_fit_page()
        }
        onClick={() => fit(nextFitMode)}
      >
        {nextFitMode === "width" ? <MoveHorizontal /> : <MoveVertical />}
      </TooltipButton>
      <DocxFindPopover
        findMatches={findMatches}
        navigateFind={navigateFind}
        onViewStateChange={onViewStateChange}
        viewState={viewState}
      />
      <TooltipButton
        label={m.document_open_externally()}
        onClick={onOpenExternal}
      >
        <FolderOpen />
      </TooltipButton>
      {toolbarActions}
    </div>
  );
}

function DocxFindPopover({
  findMatches,
  navigateFind,
  onViewStateChange,
  viewState,
}: {
  findMatches: number;
  navigateFind(direction: 1 | -1): void;
  onViewStateChange(
    update:
      | DocumentViewState
      | ((current: DocumentViewState) => DocumentViewState),
  ): void;
  viewState: DocumentViewState;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={m.document_find_in_document()}
          title={m.document_find_in_document()}
        >
          <Search />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex items-center gap-1" role="search">
          <Input
            autoFocus
            aria-label={m.document_find_in_document()}
            placeholder={m.document_find_placeholder()}
            value={viewState.findQuery}
            onChange={(event) =>
              onViewStateChange((current) => ({
                ...current,
                activeFindIndex: 0,
                findQuery: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") navigateFind(event.shiftKey ? -1 : 1);
            }}
          />
          <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
            {viewState.findQuery.trim()
              ? m.document_find_count({
                  current: String(findMatches ? viewState.activeFindIndex + 1 : 0),
                  total: String(findMatches),
                })
              : null}
          </span>
          <TooltipButton
            label={m.document_previous_result()}
            disabled={!findMatches}
            onClick={() => navigateFind(-1)}
          >
            <ChevronLeft />
          </TooltipButton>
          <TooltipButton
            label={m.document_next_result()}
            disabled={!findMatches}
            onClick={() => navigateFind(1)}
          >
            <ChevronRight />
          </TooltipButton>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PageNumberInput({
  onPageChange,
  pageNumber,
}: {
  onPageChange(page: number): void;
  pageNumber: number;
}) {
  const [draft, setDraft] = useState(String(pageNumber));
  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    onPageChange(Number.isFinite(parsed) ? parsed : pageNumber);
  };
  return (
    <Input
      className="h-7 w-12 rounded-none px-1 text-center text-xs tabular-nums"
      aria-label={m.document_page_number()}
      inputMode="numeric"
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function TooltipButton({
  children,
  grouped = false,
  label,
  ...props
}: {
  children: ReactNode;
  grouped?: boolean;
  label: string;
} & Omit<
  React.ComponentProps<typeof Button>,
  "children" | "size" | "variant"
>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={grouped ? "outline" : "ghost"}
          {...props}
        >
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
