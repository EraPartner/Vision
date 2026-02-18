import { useState, useMemo } from "react";
import { format, differenceInDays } from "date-fns";
import { Plus, CalendarClock, Repeat, Trash2, Pencil, ToggleLeft, ToggleRight, AlertCircle, CheckCircle2, Circle, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/shared/DataTable";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  // Parse the date string (YYYY-MM-DD) explicitly
  const [year, month, day] = dateStr.split('-').map(Number);
  
  // Get today's date at midnight in local time
  const today = new Date();
  const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
  
  // Create due date at midnight in local time
  const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);
  
  // Calculate the difference in days using normalized dates
  const days = differenceInDays(normalizedDue, normalizedToday);
  
  // Calculate if it's the same day
  if (days === 0) {
    return <Badge className="bg-chart-3/20 text-chart-3 border-chart-3/30">Today</Badge>;
  }
  
  if (days < 0) {
    return <Badge variant="destructive">Overdue</Badge>;
  }
  if (days === 1) {
    return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">Tomorrow</Badge>;
  }
  if (days <= 7) {
    return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">In {days}d</Badge>;
  }
  return <Badge variant="secondary">{format(normalizedDue, "PP")}</Badge>;
}

type TableRow = PlannedPayment & { _idx: number };

export default function PlannedPaymentsPage() {
  const [showAll, setShowAll] = useState(false);
  const { payments, addPayment, updatePayment, deletePayment, toggleActive, executePayment, loading, error } = usePlannedPayments(showAll);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedPayment | undefined>();
  const [actionLoading, setActionLoading] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [paymentToLink, setPaymentToLink] = useState<PlannedPayment | null>(null);

  // Filter payments based on showAll state (for client-side filtering after local updates)
  const filteredPayments = useMemo(() => {
    if (showAll) {
      return payments;
    }
    return payments.filter((p) => p.is_active);
  }, [payments, showAll]);

  const rows: TableRow[] = useMemo(
    () => filteredPayments.map((p, i) => ({ ...p, _idx: i })),
    [filteredPayments]
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
    const today = new Date();
    const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    
    return payments
      .filter((p) => p.is_active)
      .filter((p) => {
        const [year, month, day] = p.due_date.split('-').map(Number);
        const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);
        
        const days = differenceInDays(normalizedDue, normalizedToday);
        return days >= 0 && days <= 7; // Due within the next 7 days (including today)
      }).length;
  }, [payments]);

  const executed = useMemo(() => {
    return payments.filter((p) => p.is_executed).length;
  }, [payments]);

  const pending = useMemo(() => {
    return payments.filter((p) => p.is_active && !p.is_executed).length;
  }, [payments]);

  const columns = [
    {
      key: "is_executed",
      header: "",
      editable: false,
      className: "w-12",
      render: (row: TableRow) => (
        <Button
          variant="ghost"
          size="icon"
          className={`h-8 w-8 ${row.is_executed ? "text-accent hover:text-accent" : "text-muted-foreground hover:text-foreground"}`}
          onClick={async (e) => { 
            e.stopPropagation(); 
            
            if (!row.is_executed) {
              // Open dialog to select transaction
              setPaymentToLink(row);
              setLinkDialogOpen(true);
            }
          }}
          disabled={actionLoading || !row.is_active || row.is_executed}
          title={row.is_executed ? `Executed (linked to transaction #${row.executed_transaction_id})` : "Execute payment"}
        >
          {row.is_executed ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
        </Button>
      ),
    },
    {
      key: "name",
      header: "Payment",
      editable: false,
      defaultWidth: 180,
      render: (row: TableRow) => (
        <div className="flex flex-col gap-0.5">
          <span className={`font-medium ${
            !row.is_active ? "text-muted-foreground line-through" : 
            row.is_executed ? "text-muted-foreground line-through" : 
            "text-foreground"
          }`}>
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
      defaultWidth: 160,
      render: (row: TableRow) =>
        row.is_recurring ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Repeat className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm">
                {row.frequency === "custom" && row.custom_interval_days
                  ? `Every ${row.custom_interval_days}d`
                  : FREQ_LABELS[row.frequency ?? "monthly"]}
              </span>
            </div>
            {row.execution_count > 0 && (
              <span className="text-xs text-muted-foreground">
                Executed {row.execution_count}x
              </span>
            )}
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
          onClick={async (e) => { 
            e.stopPropagation(); 
            setActionLoading(true);
            try {
              await toggleActive(row.id);
            } catch (err) {
              console.error("Failed to toggle status:", err);
            } finally {
              setActionLoading(false);
            }
          }}
          disabled={actionLoading}
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
            disabled={actionLoading}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={async (e) => { 
              e.stopPropagation(); 
              if (confirm(`Delete planned payment "${row.name}"?`)) {
                setActionLoading(true);
                try {
                  await deletePayment(row.id);
                } catch (err) {
                  console.error("Failed to delete payment:", err);
                } finally {
                  setActionLoading(false);
                }
              }
            }}
            disabled={actionLoading}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const handleSubmit = async (data: Omit<PlannedPayment, "id" | "created_at">) => {
    try {
      setActionLoading(true);
      if (editing) {
        await updatePayment(editing.id, data);
        setEditing(undefined);
      } else {
        await addPayment(data);
      }
      setFormOpen(false);
    } catch (err) {
      console.error("Failed to save payment:", err);
      alert("Failed to save payment. Please check console for details.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading planned payments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold text-foreground">Planned Payments</h2>
          <p className="text-muted-foreground mt-1">Manage upcoming and recurring payments</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={showAll ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowAll(!showAll)}
            className="gap-1.5"
          >
            {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {showAll ? "Showing All" : "Active Only"}
          </Button>
          <Button onClick={() => { setEditing(undefined); setFormOpen(true); }} className="gap-2">
            <Plus className="h-4 w-4" />
            New Payment
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{pending}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Executed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-accent">{executed}</p>
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