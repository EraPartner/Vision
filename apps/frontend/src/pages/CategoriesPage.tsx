import { DataTable } from "@/components/shared/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";

const categories = [
  { id: 1, name: "Groceries", transactionCount: 142, totalAmount: 4823.56, color: "primary" },
  { id: 2, name: "Income", transactionCount: 48, totalAmount: 52400.00, color: "accent" },
  { id: 3, name: "Utilities", transactionCount: 67, totalAmount: 2156.80, color: "chart-3" },
  { id: 4, name: "Dining", transactionCount: 89, totalAmount: 3421.30, color: "chart-5" },
  { id: 5, name: "Transportation", transactionCount: 156, totalAmount: 1890.45, color: "chart-4" },
  { id: 6, name: "Shopping", transactionCount: 73, totalAmount: 5670.22, color: "primary" },
  { id: 7, name: "Healthcare", transactionCount: 24, totalAmount: 1245.00, color: "destructive" },
  { id: 8, name: "Entertainment", transactionCount: 45, totalAmount: 980.90, color: "chart-4" },
  { id: 9, name: "Other", transactionCount: 112, totalAmount: 2340.10, color: "muted-foreground" },
];

const columns = [
  {
    key: "name",
    header: "Category",
    render: (row: (typeof categories)[0]) => (
      <span className="font-medium text-foreground">{row.name}</span>
    ),
  },
  {
    key: "transactionCount",
    header: "Transactions",
    render: (row: (typeof categories)[0]) => (
      <Badge variant="secondary" className="font-medium">
        {row.transactionCount}
      </Badge>
    ),
  },
  {
    key: "totalAmount",
    header: "Total Amount",
    className: "text-right",
    render: (row: (typeof categories)[0]) => (
      <span className="font-semibold text-foreground">
        €{row.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
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

export default function CategoriesPage() {
  return (
    <div className="space-y-8 animate-in">
      <div>
        <h2 className="text-3xl font-bold text-foreground">Categories</h2>
        <p className="text-muted-foreground mt-1">Manage your transaction categories</p>
      </div>

      <DataTable
        title="All Categories"
        subtitle={`${categories.length} categories`}
        columns={columns}
        data={categories}
        emptyMessage="No categories found."
      />
    </div>
  );
}
