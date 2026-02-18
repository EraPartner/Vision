import {useState} from "react";
import {DataTable} from "@/components/shared/DataTable";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Loader2, Trash2, Eye, EyeOff, ToggleLeft, ToggleRight} from "lucide-react";
import {useDeleteTransaction, useTransactions, useUpdateTransaction} from "@/hooks/useTransactions";
import {getCategoryColor} from "@/utils/categoryColors";
import {AddTransactionDialog} from "@/components/forms/AddTransactionDialog";
import {CategoryCombobox} from "@/components/shared/CategoryCombobox";
import {RecipientCombobox} from "@/components/shared/RecipientCombobox";

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
    balance?: number;
    comment?: string;
    is_active: boolean;
};

export default function TransactionsPage() {
    const [page, setPage] = useState(0);
    const [showAll, setShowAll] = useState(false);
    const { data, isLoading, error } = useTransactions({ 
        limit: PAGE_SIZE, 
        offset: page * PAGE_SIZE, 
        active: !showAll  // false = all transactions, true = active only
    });
    const updateMutation = useUpdateTransaction();
    const deleteMutation = useDeleteTransaction();

    const handleDelete = (id: number, description?: string) => {
        if (confirm(`Delete transaction${description ? ` "${description}"` : ''}?`)) {
            deleteMutation.mutate(id);
        }
    };

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({
            id,
            data: { is_active: !currentActive },
        });
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
                currency: updated.currency,
                balance: updated.balance,
                comment: updated.comment,
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
        is_active: t.is_active ?? true,
    })) || [];

    const columns = [
        {
            key: "date",
            header: "Date",
            editable: true,
            type: "date" as const,
            render: (row: TableTransaction) => (
                <span className={`whitespace-nowrap ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                    {row.date || '—'}
                </span>
            ),
        },
        {
            key: "memo", 
            header: "Description", 
            editable: true,
            render: (row: TableTransaction) => (
                <span className={row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}>
                    {row.memo}
                </span>
            ),
        },
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
                    <Badge variant="outline" className={`font-medium ${getCategoryColor(row.category)} ${!row.is_active ? 'opacity-50 line-through' : ''}`}>
                        {row.category}
                    </Badge>
                );
            },
        },
        {
            key: "recipient",
            header: "Recipient",
            editable: false,
            render: (row: TableTransaction, isEditing: boolean) => {
                if (isEditing) {
                    const originalTransaction = data?.items.find((t: any) => t.id === row.id);
                    return (
                        <RecipientCombobox
                            value={(row as any).recipientId ?? originalTransaction?.recipient_id ?? null}
                            onSelect={(recipientId) => {
                                if (!originalTransaction) return;
                                updateMutation.mutate({
                                    id: originalTransaction.id,
                                    data: {recipient_id: recipientId ?? undefined},
                                });
                            }}
                            className="w-full"
                        />
                    );
                }
                return (
                    <span className={row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}>{row.recipient}</span>
                );
            },
        },
        {
            key: "bank", 
            header: "Bank", 
            editable: true,
            render: (row: TableTransaction) => (
                <span className={row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}>
                    {row.bank}
                </span>
            ),
        },
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
                    <span className={`font-semibold ${row.amount >= 0 ? "text-accent" : "text-destructive"} ${!row.is_active ? 'opacity-50 line-through' : ''}`}>
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
                <span className={`font-mono text-sm ${!row.is_active ? 'text-muted-foreground line-through' : ''}`}>{row.currency}</span>
            ),
        },
        {
            key: "balance",
            header: "Balance",
            className: "text-right",
            editable: true,
            type: "number" as const,
            render: (row: TableTransaction) => (
                <span className={`text-sm text-muted-foreground ${!row.is_active ? 'line-through' : ''}`}>
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
                <span className={`text-sm text-muted-foreground italic ${!row.is_active ? 'line-through' : ''}`}>
                    {row.comment || '-'}
                </span>
            ),
        },
        {
            key: "is_active",
            header: "Status",
            editable: false,
            render: (row: TableTransaction) => (
                <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1.5 ${row.is_active ? 'text-accent hover:text-accent' : 'text-muted-foreground hover:text-muted-foreground opacity-50'}`}
                    onClick={(e) => { e.stopPropagation(); toggleActive(row.id, row.is_active); }}
                    disabled={updateMutation.isPending}
                >
                    {row.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                    {row.is_active ? 'Active' : 'Inactive'}
                </Button>
            ),
        },
        {
            key: "delete",
            header: "",
            className: "w-12",
            editable: false,
            render: (row: TableTransaction) => (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(row.id, row.memo || row.recipient_name)}
                    disabled={deleteMutation.isPending}
                >
                    <Trash2 className="h-4 w-4"/>
                </Button>
            ),
        },
    ];

    const actions = (
        <div className="flex gap-2">
            <Button
                variant={showAll ? "secondary" : "outline"}
                size="sm"
                onClick={() => { setShowAll(!showAll); }}
                className="gap-1.5"
            >
                {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {showAll ? "Showing All" : "Active Only"}
            </Button>
            <AddTransactionDialog />
        </div>
    );

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
                actions={actions}
            />
        </div>
    );
}