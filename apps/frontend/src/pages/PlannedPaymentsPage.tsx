import { useState, useMemo } from "react";
import { format, isPast, isToday, differenceInDays } from "date-fns";
import { Plus, CalendarClock, Repeat, Trash2, Pencil, ToggleLeft, ToggleRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/shared/DataTable";
import PlannedPaymentForm from "@/components/planned/PlannedPaymentForm";
import { usePlannedPayments, type PlannedPayment } from "@/hooks/usePlannedPayments";

const FREQ_LABELS: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  custom: "Custom",
};

function dueBadge(dateStr: string) {
  const d = new Date(dateStr);
  if (isToday(d)) return <Badge className="bg-chart-3/20 text-chart-3 border-chart-3/30">Today</Badge>;
  if (isPast(d)) return <Badge variant="destructive">Overdue</Badge>;
  const days = differenceInDays(d, new Date());
  if (days <= 7) return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">In {days}d</Badge>;
  return <Badge variant="secondary">{format(d, "PP")}</Badge>;
}

type TableRow = PlannedPayment & { _idx: number };

export default function PlannedPaymentsPage() {
  const { payments, addPayment, updatePayment, deletePayment, toggleActive } = usePlannedPayments();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedPayment | undefined>();

  const rows: TableRow[] = useMemo(
    () => payments.map((p, i) => ({ ...p, _idx: i })),
    [payments]
  );

  const totalMonthly = useMemo(() => {
    return payments
      .filter((p) => p.is_active && p.is_recurring)
      .reduce((sum, p) => {
        const mult =
          p.frequency === "daily" ? 30 :
          p.frequency === "weekly" ? 4.33 :
          p.frequency === "biweekly" ? 2.17 :
          p.frequency === "monthly" ? 1 :
          p.frequency === "quarterly" ? 1 / 3 :
          p.frequency === "yearly" ? 1 / 12 :
          p.frequency === "custom" && p.custom_interval_days ? 30 / p.custom_interval_days : 1;
        return sum + Math.abs(p.amount) * mult;
      }, 0);
  }, [payments]);

  const upcoming = useMemo(() => {
    return payments
      .filter((p) => p.is_active)
      .filter((p) => {
        const d = new Date(p.due_date);
        return differenceInDays(d, new Date()) <= 7;
      }).length;
  }, [payments]);

  const columns = [
    {
      key: "name",
      header: "Payment",
      editable: false,
      defaultWidth: 180,
      render: (row: TableRow) => (
        <div className="flex flex-col gap-0.5">
          <span className={`font-medium ${row.is_active ? "text-foreground" : "text-muted-foreground line-through"}`}>
            {row.name}
          </span>
          {row.recipient && (
            <span className="text-xs text-muted-foreground">→ {row.recipient}</span>
          )}
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      editable: false,
      defaultWidth: 120,
      render: (row: TableRow) => (
        <span className={`font-semibold tabular-nums ${row.amount < 0 ? "text-destructive" : "text-accent"}`}>
          {row.amount < 0 ? "−" : "+"}{Math.abs(row.amount).toFixed(2)} {row.currency}
        </span>
      ),
    },
    {
      key: "due_date",
      header: "Due Date",
      editable: false,
      defaultWidth: 130,
      render: (row: TableRow) => dueBadge(row.due_date),
    },
    {
      key: "is_recurring",
      header: "Recurrence",
      editable: false,
      defaultWidth: 140,
      render: (row: TableRow) =>
        row.is_recurring ? (
          <div className="flex items-center gap-1.5">
            <Repeat className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm">
              {row.frequency === "custom" && row.custom_interval_days
                ? `Every ${row.custom_interval_days}d`
                : FREQ_LABELS[row.frequency ?? "monthly"]}
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">One-time</span>
        ),
    },
    {
      key: "category",
      header: "Category",
      editable: false,
      defaultWidth: 120,
      render: (row: TableRow) =>
        row.category ? (
          <Badge variant="outline" className="font-medium">{row.category}</Badge>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        ),
    },
    {
      key: "is_active",
      header: "Status",
      editable: false,
      defaultWidth: 100,
      render: (row: TableRow) => (
        <Button
          variant="ghost"
          size="sm"
          className={`gap-1.5 ${row.is_active ? "text-accent hover:text-accent" : "text-muted-foreground hover:text-foreground"}`}
          onClick={(e) => { e.stopPropagation(); toggleActive(row.id); }}
        >
          {row.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
          {row.is_active ? "Active" : "Paused"}
        </Button>
      ),
    },
    {
      key: "actions",
      header: "",
      editable: false,
      className: "w-20",
      render: (row: TableRow) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
            onClick={(e) => { e.stopPropagation(); setEditing(row); setFormOpen(true); }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={(e) => { e.stopPropagation(); deletePayment(row.id); }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const handleSubmit = (data: Omit<PlannedPayment, "id" | "created_at">) => {
    if (editing) {
      updatePayment(editing.id, data);
      setEditing(undefined);
    } else {
      addPayment(data);
    }
  };

  return (
    <div className="space-y-8 animate-in">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold text-foreground">Planned Payments</h2>
          <p className="text-muted-foreground mt-1">Manage upcoming and recurring payments</p>
        </div>
        <Button onClick={() => { setEditing(undefined); setFormOpen(true); }} className="gap-2">
          <Plus className="h-4 w-4" />
          New Payment
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-none shadow-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Planned</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{payments.length}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Repeat className="h-4 w-4" /> Est. Monthly
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">{totalMonthly.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <CalendarClock className="h-4 w-4" /> Due This Week
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{upcoming}</p>
          </CardContent>
        </Card>
      </div>

      <DataTable
        title="All Payments"
        subtitle={`${payments.length} planned payments`}
        columns={columns}
        data={rows}
        emptyMessage="No planned payments yet. Click 'New Payment' to create one."
      />

      <PlannedPaymentForm
        open={formOpen}
        onOpenChange={(open) => { setFormOpen(open); if (!open) setEditing(undefined); }}
        onSubmit={handleSubmit}
        initial={editing}
        key={editing?.id ?? "new"}
      />
    </div>
  );
}
