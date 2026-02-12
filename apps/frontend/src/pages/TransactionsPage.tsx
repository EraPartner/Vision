import {useState} from "react";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Trash2} from "lucide-react";
import {useDeleteTransaction, useTransactions, useUpdateTransaction} from "@/hooks/useTransactions";
import {getCategoryColor} from "@/utils/categoryColors";
import {AddTransactionDialog} from "@/components/forms/AddTransactionDialog";
import {CategoryCombobox} from "@/components/shared/CategoryCombobox";

const PAGE_SIZE = 50;

type TableTransaction = {
    id: number;
    date: string;
    memo: string;
    category: string;
    recipient: string;
    bank: string;
    amount: number;
    currency: string;
};

export default function TransactionsPage() {
    const [page, setPage] = useState(0);
    const { data, isLoading, error } = useTransactions({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, active: true });
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

    const totalItems = data?.total ?? data?.items?.length ?? 0;

    // Map backend data to table format
    const transactions: TableTransaction[] = data?.items.map((t: any) => ({
        id: t.id,
        date: t.transaction_date || t.date || '',
        memo: t.memo || '',
        category: t.category_name || 'Uncategorized',
        categoryId: t.category_id,
        recipient: t.recipient_name || 'Unknown',
        recipientId: t.recipient_id || 0,
        bank: t.bank_account,
        amount: t.amount,
        currency: t.currency || 'EUR',
        balance: t.balance,
        comment: t.comment || '',
    })) || [];

    const columns = [
        {
            key: "date",
            header: "Date",
            editable: true,
            type: "date" as const,
            render: (row: TableTransaction) => (
                <span className="text-foreground whitespace-nowrap">{row.date || '—'}</span>
            ),
        },
        {key: "memo", header: "Description", editable: true},
        {
            key: "category",
            header: "Category",
            editable: false,
            render: (row: TableTransaction, isEditing: boolean) => {
                if (isEditing) {
                    const originalTransaction = data?.items.find((t: any) => t.id === row.id);
                    return (
                        <CategoryCombobox
                            value={(row as any).categoryId ?? originalTransaction?.category_id ?? null}
                            onSelect={(catId) => {
                                if (!originalTransaction) return;
                                updateMutation.mutate({
                                    id: originalTransaction.id,
                                    data: {category_id: catId ?? undefined},
                                });
                            }}
                            className="w-full"
                        />
                    );
                }
                return (
                    <Badge variant="outline" className={`font-medium ${getCategoryColor(row.category)}`}>
                        {row.category}
                    </Badge>
                );
            },
        },
        {key: "recipient", header: "Recipient", editable: false},
        {key: "bank", header: "Bank", editable: true},
        {
            key: "amount",
            header: "Amount",
            className: "text-right",
            editable: true,
            type: "number" as const,
            render: (row: TableTransaction) => {
                const formattedAmount = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: row.currency,
                }).format(Math.abs(row.amount));
                
                return (
                    <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"}`}>
                        {row.amount >= 0 ? "+" : ""}{formattedAmount}
                    </span>
                );
            },
        },
        {
            key: "currency",
            header: "Currency",
            editable: true,
            render: (row: TableTransaction) => (
                <span className="font-mono text-sm">{row.currency}</span>
            ),
        },
        {
            key: "balance",
            header: "Balance",
            className: "text-right",
            editable: true,
            type: "number" as const,
            render: (row: TableTransaction) => (
                <span className="text-sm text-muted-foreground">
                    {row.balance !== undefined && row.balance !== null 
                        ? new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: row.currency,
                        }).format(row.balance)
                        : '-'
                    }
                </span>
            ),
        },
        {
            key: "comment",
            header: "Comment",
            editable: true,
            render: (row: TableTransaction) => (
                <span className="text-sm text-muted-foreground italic">
                    {row.comment || '-'}
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
                subtitle={`${totalItems} transactions`}
                columns={columns}
                data={transactions}
                onRowUpdate={handleUpdate}
                emptyMessage="No transactions found."
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={totalItems}
                onPageChange={setPage}
                actions={<AddTransactionDialog />}
            />
        </div>
    );
}
