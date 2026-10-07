import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { cn } from "@/lib/utils";

interface ColumnFilterProps {
    header: string;
    value: string;
    onChange: (value: string) => void;
    uniqueValues: string[];
    onClose: () => void;
}

export function ColumnFilter({
    header,
    value,
    onChange,
    uniqueValues,
    onClose,
}: ColumnFilterProps) {
    const { t } = useLanguage();
    const [filterSearch, setFilterSearch] = useState("");

    const filteredValues = uniqueValues.filter((candidate) =>
        candidate.toLowerCase().includes(filterSearch.toLowerCase())
    );

    return (
        <div className="space-y-2">
            <p className="px-1 type-footnote font-medium text-label-secondary">{t('table.filterLabel', { header })}</p>
            <Input
                placeholder={t('table.filterInputPlaceholder', { header: header.toLowerCase() })}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="h-8"
                autoFocus
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onClose();
                    }
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onChange("");
                        onClose();
                    }
                }}
            />
            {uniqueValues.length > 0 && uniqueValues.length <= 100 && (
                <>
                    {uniqueValues.length > 8 && (
                        <Input
                            placeholder={t('table.searchValues')}
                            value={filterSearch}
                            onChange={(event) => setFilterSearch(event.target.value)}
                            className="h-8 type-footnote"
                        />
                    )}
                    <div className="max-h-40 overflow-y-auto space-y-0.5">
                        {filteredValues.slice(0, 30).map((candidate) => (
                            <Button
                                key={candidate}
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-pressed={value === candidate}
                                onClick={() => {
                                    onChange(candidate);
                                    onClose();
                                }}
                                className={cn(
                                    "h-7 w-full justify-start rounded-chip px-2 type-footnote font-normal",
                                    value === candidate
                                        ? "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary"
                                        : "text-foreground",
                                )}
                            >
                                <span className="truncate">{candidate}</span>
                            </Button>
                        ))}
                        {filteredValues.length > 30 && (
                            <p className="px-2 type-caption text-label-secondary">
                                {t('table.moreValues', { count: (filteredValues.length - 30).toString() })}
                            </p>
                        )}
                    </div>
                </>
            )}
            {value && (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                        onChange("");
                        onClose();
                    }}
                    className="h-7 w-full type-footnote text-label-secondary"
                >
                    {t('table.clearFilter')}
                </Button>
            )}
        </div>
    );
}
