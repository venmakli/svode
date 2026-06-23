import { Button } from "@/components/ui/button";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import { CalendarEngine } from "./calendar-engine";
import { CalendarMiniToolbar } from "./calendar-mini-toolbar";
import {
  CalendarEmptyOverlay,
  CalendarLoadingState,
  NoDateFieldState,
} from "./calendar-states";
import { CalendarTitlePopover } from "./calendar-title-popover";
import type { CalendarViewProps } from "../../model/calendar-types";
import {
  reportCalendarError,
  useCalendarViewRuntime,
} from "../../hooks/calendar/use-calendar-view-runtime";
import * as m from "@/paraglide/messages.js";

export function CalendarView({
  name,
  view,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  searchQuery,
  filters,
  sort,
  refreshToken,
  createFocusSignal = 0,
  createAsFolder = false,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onOpenPath,
  onDuplicateEntry,
  onDeleteEntry,
  onSchemaChange,
  onUpdateView,
  onCreateEntry,
}: CalendarViewProps) {
  const {
    addDateColumnForView,
    calendarRef,
    createDraft,
    createEntryFromDraft,
    currentDate,
    dateColumn,
    events,
    goToDate,
    goToNext,
    goToPrevious,
    goToToday,
    handleDateClick,
    handleDayCellDidMount,
    handleEventClick,
    handleEventDrop,
    handleEventResize,
    handleSelect,
    hiddenCount,
    locale,
    loading,
    periodLabel,
    pickerOpen,
    propertyContext,
    scope,
    setCreateDraft,
    setListScope,
    setPickerOpen,
    setScope,
    shellRef,
    syncDates,
    visibleCount,
  } = useCalendarViewRuntime({
    name,
    view,
    schema,
    collectionPath,
    spacePath,
    projectPath,
    searchQuery,
    filters,
    refreshToken,
    sort,
    createFocusSignal,
    createAsFolder,
    onOpenEntry,
    onOpenNestedPeek,
    onOpenNestedCollection,
    onOpenFullPage,
    onOpenPath,
    onDuplicateEntry,
    onDeleteEntry,
    onSchemaChange,
    onUpdateView,
    onCreateEntry,
  });

  if (!dateColumn) {
    return (
      <NoDateFieldState
        loading={loading}
        onAddDateColumn={() =>
          void addDateColumnForView().catch(reportCalendarError)
        }
      />
    );
  }

  if (loading) {
    return <CalendarLoadingState />;
  }

  return (
    <div ref={shellRef} className={detailPageViewClassName}>
      <div className="svode-calendar flex flex-col rounded-lg bg-background ring-1 ring-foreground/10">
        <CalendarMiniToolbar
          scope={scope}
          periodLabel={periodLabel}
          currentDate={currentDate}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          onPrev={goToPrevious}
          onNext={goToNext}
          onToday={goToToday}
          onScopeChange={setScope}
          onGotoDate={goToDate}
        />
        <div className="relative overflow-visible">
          <CalendarEngine
            calendarRef={calendarRef}
            scope={scope}
            events={events}
            locale={locale}
            propertyContext={propertyContext}
            onDateClick={handleDateClick}
            onSelect={handleSelect}
            onEventClick={handleEventClick}
            onEventDrop={handleEventDrop}
            onEventResize={handleEventResize}
            onDayCellDidMount={handleDayCellDidMount}
            onDatesSet={syncDates}
            onOpenEntry={onOpenEntry}
            onOpenNestedPeek={onOpenNestedPeek}
            onOpenNestedCollection={onOpenNestedCollection}
            onDuplicateEntry={onDuplicateEntry}
            onDeleteEntry={onDeleteEntry}
          />
          {visibleCount === 0 ? <CalendarEmptyOverlay /> : null}
        </div>
        {hiddenCount > 0 ? (
          <div className="flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{m.calendar_hidden_no_date({ count: hiddenCount })}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={setListScope}
            >
              {m.calendar_show_as_list()}
            </Button>
          </div>
        ) : null}
      </div>
      <CalendarTitlePopover
        draft={createDraft}
        onCancel={() => setCreateDraft(null)}
        onCreate={(title, draft) =>
          void createEntryFromDraft(title, draft).catch(reportCalendarError)
        }
      />
    </div>
  );
}
