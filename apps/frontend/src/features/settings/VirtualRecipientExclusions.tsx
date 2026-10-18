import { useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface Props {
    recipients: { id: number; name: string; is_active: boolean }[];
    excluded: ReadonlySet<number>;
    onToggle: (id: number) => void;
    label: string;
    hiddenLabel: string;
}

/** One tab stop, with arrow/Home/End navigation across the entire virtual list. */
export function VirtualRecipientExclusions({
    recipients,
    excluded,
    onToggle,
    label,
    hiddenLabel,
}: Props) {
    const root = useRef<HTMLDivElement>(null);
    const [activeId, setActiveId] = useState<number>();
    const activeIndex = Math.max(
        0,
        recipients.findIndex((item) => item.id === activeId),
    );
    const virtualizer = useVirtualizer({
        count: recipients.length,
        getScrollElement: () =>
            root.current?.querySelector<HTMLElement>(
                "[data-radix-scroll-area-viewport]",
            ) ?? null,
        estimateSize: () => 40,
        initialRect: { height: 200, width: 300 },
        overscan: 4,
        getItemKey: (index) => recipients[index]!.id,
        // Preserve the focused checkbox when scrolling or changing its sort position.
        rangeExtractor: (range) =>
            [...new Set([...defaultRangeExtractor(range), activeIndex])].sort(
                (a, b) => a - b,
            ),
    });
    function focusIndex(index: number) {
        const next = Math.max(0, Math.min(recipients.length - 1, index));
        const item = recipients[next];
        if (!item) return;
        setActiveId(item.id);
        virtualizer.scrollToIndex(next);
        requestAnimationFrame(() =>
            root.current
                ?.querySelector<HTMLElement>(`#recipient-${item.id}`)
                ?.focus(),
        );
    }
    return (
        <ScrollArea ref={root} className="mt-3 h-[200px]">
            <div
                role="list"
                aria-label={label}
                className="relative pr-3"
                style={{ height: virtualizer.getTotalSize() }}
            >
                {virtualizer.getVirtualItems().map((row) => {
                    const recipient = recipients[row.index]!;
                    return (
                        <div
                            key={recipient.id}
                            ref={virtualizer.measureElement}
                            data-index={row.index}
                            role="listitem"
                            aria-posinset={row.index + 1}
                            aria-setsize={recipients.length}
                            className="absolute left-0 right-3 flex items-center gap-3 rounded-control px-3 py-2 transition-[background-color] duration-fast ease-glide hover:bg-foreground/[0.04]"
                            style={{ transform: `translateY(${row.start}px)` }}
                        >
                            <Checkbox
                                id={`recipient-${recipient.id}`}
                                checked={excluded.has(recipient.id)}
                                tabIndex={row.index === activeIndex ? 0 : -1}
                                onFocus={() => setActiveId(recipient.id)}
                                onCheckedChange={() => onToggle(recipient.id)}
                                onKeyDown={(event) => {
                                    const target =
                                        event.key === "ArrowDown"
                                            ? row.index + 1
                                            : event.key === "ArrowUp"
                                              ? row.index - 1
                                              : event.key === "Home"
                                                ? 0
                                                : event.key === "End"
                                                  ? recipients.length - 1
                                                  : undefined;
                                    if (target !== undefined) {
                                        event.preventDefault();
                                        focusIndex(target);
                                    }
                                }}
                            />
                            <Label
                                htmlFor={`recipient-${recipient.id}`}
                                className="flex flex-1 cursor-pointer items-center justify-between font-normal"
                            >
                                <span>{recipient.name}</span>
                                {!recipient.is_active && (
                                    <Badge
                                        variant="outline"
                                        size="sm"
                                        className="ml-2"
                                    >
                                        {hiddenLabel}
                                    </Badge>
                                )}
                            </Label>
                        </div>
                    );
                })}
            </div>
        </ScrollArea>
    );
}
