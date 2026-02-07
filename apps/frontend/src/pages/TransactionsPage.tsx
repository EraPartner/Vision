import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Trash2} from "lucide-react";
import {useDeleteTransaction, useTransactions, useUpdateTransaction} from "@/hooks/useTransactions";

const categoryColor: Record<string, string> = {
    GROCERIES: "bg-primary/15 text-primary border-primary/30",
    INCOME: "bg-accent/15 text-accent border-accent/30",
    UTILITIES: "bg-chart-3/15 text-chart-3 border-chart-3/30",
    DINING: "bg-chart-5/15 text-chart-5 border-chart-5/30",
    TRANSPORTATION: "bg-chart-4/15 text-chart-4 border-chart-4/30",
    SHOPPING: "bg-primary/15 text-primary border-primary/30",
    HEALTHCARE: "bg-destructive/15 text-destructive border-destructive/30",
    ENTERTAINMENT: "bg-chart-4/15 text-chart-4 border-chart-4/30",
};

type TableTransaction = {
    id: number;
    date: string;
    memo: string;
    category: string;
    recipient: string;
    bank: string;
    amount: number;
};

export default function TransactionsPage() {
  const { data, isLoading, error } = useTransactions({ limit: 50, active: true });
    const updateMutation = useUpdateTransaction();
    const deleteMutation = useDeleteTransaction();

    const handleDelete = (id: number) => {
        deleteMutation.mutate(id);
    };

    const handleUpdate = (idx: number, updated: TableTransaction) => {
        const originalTransaction = data?.items[idx];
        if (!originalTransaction) return;

        updateMutation.mutate({
            id: originalTransaction.id,
            data: {
                transaction_date: updated.date,
                memo: updated.memo,
                amount: updated.amount,
                bank_account: updated.bank,
            },
        });
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-96">
                <Loader2 className="h-8 w-8 animate-spin text-primary"/>
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Transactions</h2>
                    <p className="text-destructive mt-1">Error loading transactions: {error.message}</p>
                </div>
            </div>
        );
    }

    // Map backend data to table format
    const transactions: TableTransaction[] = data?.items.map((t) => ({
        id: t.id,
        date: t.transaction_date,
        memo: t.memo || '',
        category: t.category_id ? 'Category' : 'Uncategorized',
        recipient: String(t.recipient_id || ''),
        bank: t.bank_account,
        amount: t.amount,
    })) || [];

    const columns = [
        {key: "date", header: "Date", editable: true, type: "date" as const},
        {key: "memo", header: "Description", editable: true},
        {
            key: "category",
            header: "Category",
            editable: false,
            render: (row: TableTransaction) => (
                <Badge variant="outline" className={`font-medium ${categoryColor[row.category] || ""}`}>
                    {row.category}
                </Badge>
            ),
        },
        {key: "recipient", header: "Recipient", editable: false},
        {key: "bank", header: "Bank", editable: true},
        {
            key: "amount",
            header: "Amount",
            className: "text-right",
            editable: true,
            type: "number" as const,
            render: (row: TableTransaction) => (
                <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
          {row.amount >= 0 ? "+" : ""}€{Math.abs(row.amount).toFixed(2)}
        </span>
            ),
        },
        {
            key: "delete",
            header: "",
            className: "w-12",
            render: (row: TableTransaction) => (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(row.id)}
                    disabled={deleteMutation.isPending}
                >
                    <Trash2 className="h-4 w-4"/>
                </Button>
            ),
        },
    ];

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
                onRowUpdate={handleUpdate}
                emptyMessage="No transactions found."
            />
        </div>
    );
}

