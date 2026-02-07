import { DataTable } from "@/components/shared/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";

const recipients = [
  { id: 1, name: "Whole Foods", transactionCount: 34, totalAmount: 2856.78, lastTransaction: "2026-02-07" },
  { id: 2, name: "Employer Inc.", transactionCount: 12, totalAmount: 50400.00, lastTransaction: "2026-02-06" },
  { id: 3, name: "City Power", transactionCount: 12, totalAmount: 1491.60, lastTransaction: "2026-02-05" },
  { id: 4, name: "Olive Garden", transactionCount: 8, totalAmount: 543.20, lastTransaction: "2026-02-04" },
  { id: 5, name: "Shell", transactionCount: 45, totalAmount: 1890.00, lastTransaction: "2026-02-03" },
  { id: 6, name: "Amazon", transactionCount: 28, totalAmount: 3456.90, lastTransaction: "2026-02-02" },
  { id: 7, name: "Client Co.", transactionCount: 6, totalAmount: 5100.00, lastTransaction: "2026-02-01" },
  { id: 8, name: "FitLife Gym", transactionCount: 12, totalAmount: 599.88, lastTransaction: "2026-01-31" },
  { id: 9, name: "Pathé", transactionCount: 15, totalAmount: 360.00, lastTransaction: "2026-01-30" },
  { id: 10, name: "WaterCorp", transactionCount: 12, totalAmount: 462.00, lastTransaction: "2026-01-29" },
];

const columns = [
  {
    key: "name",
    header: "Recipient",
    render: (row: (typeof recipients)[0]) => (
      <span className="font-medium text-foreground">{row.name}</span>
    ),
  },
  {
    key: "transactionCount",
    header: "Transactions",
    render: (row: (typeof recipients)[0]) => (
      <Badge variant="secondary" className="font-medium">
        {row.transactionCount}
      </Badge>
    ),
  },
  {
    key: "totalAmount",
    header: "Total Amount",
    className: "text-right",
    render: (row: (typeof recipients)[0]) => (
      <span className="font-semibold text-foreground">
        €{row.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
    ),
  },
  {
    key: "lastTransaction",
    header: "Last Transaction",
    render: (row: (typeof recipients)[0]) => (
      <span className="text-muted-foreground">{row.lastTransaction}</span>
    ),
  },
  {
    key: "actions",
    header: "",
    className: "w-12",
    render: () => (
      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
        <Pencil className="h-4 w-4" />
      </Button>
    ),
  },
];

export default function RecipientsPage() {
  return (
    <div className="space-y-8 animate-in">
      <div>
        <h2 className="text-3xl font-bold text-foreground">Recipients</h2>
        <p className="text-muted-foreground mt-1">View and manage transaction recipients</p>
      </div>

      <DataTable
        title="All Recipients"
        subtitle={`${recipients.length} recipients`}
        columns={columns}
        data={recipients}
        emptyMessage="No recipients found."
      />
    </div>
  );
}
