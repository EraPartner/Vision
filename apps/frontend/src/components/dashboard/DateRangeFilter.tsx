import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "lucide-react";
import { useState } from "react";

interface DateRangeFilterProps {
  onFilterChange: (startDate: Date | null, endDate: Date | null) => void;
}

export function DateRangeFilter({ onFilterChange }: DateRangeFilterProps) {
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  const handleStartDateChange = (value: string) => {
    setStartDate(value);
    const date = value ? new Date(value) : null;
    onFilterChange(date, endDate ? new Date(endDate) : null);
  };

  const handleEndDateChange = (value: string) => {
    setEndDate(value);
    const date = value ? new Date(value) : null;
    onFilterChange(startDate ? new Date(startDate) : null, date);
  };

  const handleClear = () => {
    setStartDate("");
    setEndDate("");
    onFilterChange(null, null);
  };

  return (
    <Card className="border-none shadow-lg bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-800">
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <Calendar className="h-5 w-5 text-white" />
            </div>
            <span className="font-semibold text-sm">Filter by Date Range</span>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="start-date" className="text-sm text-muted-foreground">
              From:
            </label>
            <input
              id="start-date"
              type="date"
              value={startDate}
              onChange={(e) => handleStartDateChange(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="end-date" className="text-sm text-muted-foreground">
              To:
            </label>
            <input
              id="end-date"
              type="date"
              value={endDate}
              onChange={(e) => handleEndDateChange(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {(startDate || endDate) && (
            <button
              onClick={handleClear}
              className="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-sm font-medium hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              Clear Filter
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
