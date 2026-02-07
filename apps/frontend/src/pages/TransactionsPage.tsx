import { DataTable } from "@/components/shared/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

const transactions = [
  { id: 1, date: "2026-02-07", description: "Grocery Store", amount: -82.45, category: "Groceries", recipient: "Whole Foods", bank: "ING" },
  { id: 2, date: "2026-02-06", description: "Monthly Salary", amount: 4200.00, category: "Income", recipient: "Employer Inc.", bank: "ING" },
  { id: 3, date: "2026-02-05", description: "Electric Bill", amount: -124.30, category: "Utilities", recipient: "City Power", bank: "ABN AMRO" },
  { id: 4, date: "2026-02-04", description: "Restaurant Dinner", amount: -67.90, category: "Dining", recipient: "Olive Garden", bank: "ING" },
  { id: 5, date: "2026-02-03", description: "Gas Station", amount: -45.00, category: "Transportation", recipient: "Shell", bank: "Rabobank" },
  { id: 6, date: "2026-02-02", description: "Online Shopping", amount: -156.78, category: "Shopping", recipient: "Amazon", bank: "ING" },
  { id: 7, date: "2026-02-01", description: "Freelance Payment", amount: 850.00, category: "Income", recipient: "Client Co.", bank: "ABN AMRO" },
  { id: 8, date: "2026-01-31", description: "Gym Membership", amount: -49.99, category: "Healthcare", recipient: "FitLife Gym", bank: "ING" },
  { id: 9, date: "2026-01-30", description: "Movie Tickets", amount: -24.00, category: "Entertainment", recipient: "Pathé", bank: "Rabobank" },
  { id: 10, date: "2026-01-29", description: "Water Bill", amount: -38.50, category: "Utilities", recipient: "WaterCorp", bank: "ABN AMRO" },
];

const categoryColor: Record<string, string> = {
  Groceries: "bg-primary/15 text-primary border-primary/30",
  Income: "bg-accent/15 text-accent border-accent/30",
  Utilities: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  Dining: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  Transportation: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  Shopping: "bg-primary/15 text-primary border-primary/30",
  Healthcare: "bg-destructive/15 text-destructive border-destructive/30",
  Entertainment: "bg-chart-4/15 text-chart-4 border-chart-4/30",
};

const columns = [
  { key: "date", header: "Date" },
  { key: "description", header: "Description" },
  {
    key: "category",
    header: "Category",
    render: (row: (typeof transactions)[0]) => (
      <Badge variant="outline" className={`font-medium ${categoryColor[row.category] || ""}`}>
        {row.category}
      </Badge>
    ),
  },
  { key: "recipient", header: "Recipient" },
  { key: "bank", header: "Bank" },
  {
    key: "amount",
    header: "Amount",
    className: "text-right",
    render: (row: (typeof transactions)[0]) => (
      <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
        {row.amount >= 0 ? "+" : ""}€{Math.abs(row.amount).toFixed(2)}
      </span>
    ),
  },
  {
    key: "actions",
    header: "",
    className: "w-12",
    render: () => (
      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive">
        <Trash2 className="h-4 w-4" />
      </Button>
    ),
  },
];

export default function TransactionsPage() {
  return (
    <div className="space-y-8 animate-in">
      <div>
        <h2 className="text-3xl font-bold text-foreground">Transactions</h2>
        <p className="text-muted-foreground mt-1">View and manage all your transactions</p>
      </div>

      <DataTable
        title="All Transactions"
        subtitle={`${transactions.length} transactions`}
        columns={columns}
        data={transactions}
        emptyMessage="No transactions found."
      />
    </div>
  );
}
