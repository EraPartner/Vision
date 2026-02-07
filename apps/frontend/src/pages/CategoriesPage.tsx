import { useState } from "react";
import { DataTable } from "@/components/shared/DataTable";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

const initialCategories = [
  { id: 1, name: "Groceries", transactionCount: 142, totalAmount: 4823.56 },
  { id: 2, name: "Income", transactionCount: 48, totalAmount: 52400.00 },
  { id: 3, name: "Utilities", transactionCount: 67, totalAmount: 2156.80 },
  { id: 4, name: "Dining", transactionCount: 89, totalAmount: 3421.30 },
  { id: 5, name: "Transportation", transactionCount: 156, totalAmount: 1890.45 },
  { id: 6, name: "Shopping", transactionCount: 73, totalAmount: 5670.22 },
  { id: 7, name: "Healthcare", transactionCount: 24, totalAmount: 1245.00 },
  { id: 8, name: "Entertainment", transactionCount: 45, totalAmount: 980.90 },
  { id: 9, name: "Other", transactionCount: 112, totalAmount: 2340.10 },
];

type Category = (typeof initialCategories)[0];

export default function CategoriesPage() {
  const [categories, setCategories] = useState(initialCategories);

  const handleUpdate = (idx: number, updated: Category) => {
    setCategories((prev) => prev.map((c, i) => (i === idx ? updated : c)));
    toast.success("Category updated");
  };

  const columns = [
    {
      key: "name",
      header: "Category",
      editable: true,
      render: (row: Category, isEditing: boolean) =>
        isEditing ? null : (
          <span className="font-medium text-foreground">{row.name}</span>
        ),
    },
    {
      key: "transactionCount",
      header: "Transactions",
      render: (row: Category) => (
        <Badge variant="secondary" className="font-medium">
          {row.transactionCount}
        </Badge>
      ),
    },
    {
      key: "totalAmount",
      header: "Total Amount",
      className: "text-right",
      render: (row: Category) => (
        <span className="font-semibold text-foreground">
          €{row.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
      ),
    },
  ];

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
        onRowUpdate={handleUpdate}
        emptyMessage="No categories found."
      />
    </div>
  );
}
