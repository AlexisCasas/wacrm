"use client";

import { useMemo, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { searchFlows, type SearchableFlow } from "./flow-search";

export interface PickableFlow extends SearchableFlow {
  status: string;
}

interface FlowPickerProps {
  options: PickableFlow[];
  /** Currently stored target id ("" when none). */
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Text of the closed field when the stored target is not among the options (deleted / foreign / unknown). */
  unavailableLabel: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  /** "Showing the first {shown} of {total}" hint, rendered only when results are capped. */
  cappedLabel: (shown: number, total: number) => string;
  statusLabel: (status: string) => string;
  ariaLabel: string;
}

/**
 * Searchable single-select for the flow a node runs. Built on the Base UI Combobox the project already ships
 * (keyboard: ArrowUp/Down to move, Enter to choose, Escape to close). The popup shows a search box; results update
 * while typing; the field itself keeps showing the stored selection when the node is edited again.
 */
export function FlowPicker({ options, value, onChange, disabled, unavailableLabel, placeholder, searchPlaceholder, emptyLabel, cappedLabel, statusLabel, ariaLabel }: FlowPickerProps) {
  const [query, setQuery] = useState("");
  const selected = options.find((flow) => flow.id === value) ?? null;
  const { visible, total } = useMemo(() => searchFlows(options, query), [options, query]);
  // The selected flow must stay a valid item even when the current search hides it, or the combobox would drop it.
  const items = useMemo(() => (selected && !visible.some((flow) => flow.id === selected.id) ? [selected, ...visible] : visible), [selected, visible]);
  const triggerText = selected ? `${selected.name} · ${statusLabel(selected.status)}` : value ? unavailableLabel : placeholder;
  return (
    <Combobox.Root
      items={options}
      filteredItems={items}
      value={selected}
      onValueChange={(flow: PickableFlow | null) => onChange(flow?.id ?? "")}
      itemToStringLabel={(flow: PickableFlow) => flow.name}
      isItemEqualToValue={(a: PickableFlow, b: PickableFlow) => a.id === b.id}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      onOpenChange={(open: boolean) => { if (!open) setQuery(""); }}
      disabled={disabled}
    >
      <Combobox.Trigger
        aria-label={ariaLabel}
        className="flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-muted py-2 pr-2 pl-2.5 text-left text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-input/50"
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{triggerText}</span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" className="isolate z-50">
          <Combobox.Popup className="flex w-(--anchor-width) min-w-64 origin-(--transform-origin) flex-col rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden">
            <div className="relative border-b border-border p-1.5">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Combobox.Input
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                autoComplete="off"
                className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
            {visible.length === 0 ? (
              <p role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">{emptyLabel}</p>
            ) : (
              <Combobox.List className="max-h-64 overflow-y-auto p-1">
                {(flow: PickableFlow) => (
                  <Combobox.Item
                    key={flow.id}
                    value={flow}
                    className="relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <span className="truncate">{flow.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">· {statusLabel(flow.status)}</span>
                    <Combobox.ItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                      <CheckIcon className="size-4" />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            )}
            {total > visible.length && <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{cappedLabel(visible.length, total)}</p>}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
