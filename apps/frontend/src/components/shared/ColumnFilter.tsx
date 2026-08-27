import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
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
            <p className="text-xs font-medium text-muted-foreground px-1">{t('table.filterLabel', { header })}</p>
            <Input
                placeholder={t('table.filterInputPlaceholder', { header: header.toLowerCase() })}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="h-8 text-sm"
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
                            className="h-7 text-xs"
                        />
                    )}
                    <div className="max-h-40 overflow-y-auto space-y-0.5">
                        {filteredValues.slice(0, 30).map((candidate) => (
                            <button
                                key={candidate}
                                onClick={() => {
                                    onChange(candidate);
                                    onClose();
                                }}
                                className={cn("w-full text-left text-xs px-2 py-1 rounded hover:bg-muted transition-colors truncate", value === candidate
                                        ? "bg-primary/10 text-primary font-medium"
                                        : "text-foreground"
                                    )}
                            >
                                {candidate}
                            </button>
                        ))}
                        {filteredValues.length > 30 && (
                            <p className="text-2xs text-muted-foreground px-2">
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
                    className="w-full text-xs h-7 text-muted-foreground"
                >
                    {t('table.clearFilter')}
                </Button>
            )}
        </div>
    );
}
