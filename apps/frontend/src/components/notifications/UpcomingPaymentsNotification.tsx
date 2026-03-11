import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Bell, X, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { formatCurrency } from "@/utils/currency";
import { Link } from "react-router-dom";

export function UpcomingPaymentsNotification() {
  const [dismissed, setDismissed] = useState(false);

  const { data: upcoming } = useQuery({
    queryKey: ["upcomingPlannedPayments"],
    queryFn: async () => {
      const today = new Date();
      const nextWeek = new Date();
      nextWeek.setDate(today.getDate() + 7);

      const response = await apiClient.getPlannedTransactions({
        active: true,
        start_date: today.toISOString().split("T")[0],
        end_date: nextWeek.toISOString().split("T")[0],
        limit: 100,
      });

      // Filter out already-executed one-time payments
      return response.items.filter((pt) => !(pt.is_executed && !pt.is_recurring));
    },
    staleTime: 5 * 60_000,
  });

  if (dismissed || !upcoming || upcoming.length === 0) return null;

  return (
    <Alert className="relative border-primary/30 bg-primary/5 mb-4">
      <CalendarClock className="h-4 w-4 text-primary" />
      <AlertTitle className="flex items-center gap-2 text-primary font-semibold">
        <Bell className="h-4 w-4" />
        {upcoming.length} upcoming payment{upcoming.length > 1 ? "s" : ""} due this week
      </AlertTitle>
      <AlertDescription className="mt-2 space-y-1">
        {upcoming.slice(0, 5).map((pt) => (
          <div key={pt.id} className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {pt.memo || pt.recipient_name || "Unnamed"}
            </span>
            <span className="flex items-center gap-3 text-muted-foreground">
              <span>{pt.planned_date?.split("T")[0]}</span>
              <span className="font-semibold text-foreground">
                {formatCurrency(Math.abs(pt.amount), pt.currency || "EUR")}
              </span>
            </span>
          </div>
        ))}
        {upcoming.length > 5 && (
          <p className="text-xs text-muted-foreground">
            +{upcoming.length - 5} more
          </p>
        )}
        <div className="mt-2">
          <Link
            to="/planned"
            className="text-xs text-primary hover:underline font-medium"
          >
            View all planned payments →
          </Link>
        </div>
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-6 w-6"
        onClick={() => setDismissed(true)}
      >
        <X className="h-3 w-3" />
      </Button>
    </Alert>
  );
}
