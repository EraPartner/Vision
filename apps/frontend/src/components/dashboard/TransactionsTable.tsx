import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow,} from "@/components/ui/table";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card} from "@/components/ui/card";
import {format} from "date-fns";
import {Calendar, CreditCard, Trash2} from "lucide-react";
import {apiClient} from "@/lib/api";
import {toast} from "sonner";
import { getCategoryColor } from "@/utils/categoryColors";

interface Transaction {
    id: number;
    transaction_date: string;
    description: string;
    amount: number;
    category: string;
    bank_source?: string;
}

interface TransactionsTableProps {
    transactions: Transaction[];
    onTransactionDeleted?: () => void;
}

export function TransactionsTable({transactions, onTransactionDeleted}: TransactionsTableProps) {
    const handleDelete = async (id: number) => {
        try {
            await apiClient.deleteTransaction(id);
            toast.success("Transaction deleted");
            onTransactionDeleted?.();
        } catch (error: any) {
            toast.error("Failed to delete transaction");
        }
    };

    return (
        <Card
            className="border-none shadow-xl bg-gradient-to-br from-white to-slate-50 dark:from-slate-900 dark:to-slate-800 overflow-hidden">
            <div className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow
                            className="border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 hover:bg-slate-50/50">
                            <TableHead className="font-semibold text-slate-700 dark:text-slate-300">
                                <div className="flex items-center gap-2">
                                    <Calendar className="h-4 w-4"/>
                                    Date
                                </div>
                            </TableHead>
                            <TableHead
                                className="font-semibold text-slate-700 dark:text-slate-300">Description</TableHead>
                            <TableHead className="font-semibold text-slate-700 dark:text-slate-300">Category</TableHead>
                            <TableHead className="font-semibold text-slate-700 dark:text-slate-300">
                                <div className="flex items-center gap-2">
                                    <CreditCard className="h-4 w-4"/>
                                    Bank
                                </div>
                            </TableHead>
                            <TableHead
                                className="text-right font-semibold text-slate-700 dark:text-slate-300">Amount</TableHead>
                            <TableHead
                                className="text-right font-semibold text-slate-700 dark:text-slate-300">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {transactions.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                                    <div className="flex flex-col items-center gap-3">
                                        <div
                                            className="h-12 w-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                                            <CreditCard className="h-6 w-6 text-slate-400"/>
                                        </div>
                                        <p className="font-medium">No transactions yet</p>
                                        <p className="text-sm">Import your first CSV file to get started!</p>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : (
                            transactions.map((transaction, index) => (
                                <TableRow
                                    key={transaction.id}
                                    className="border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors"
                                    style={{animationDelay: `${index * 50}ms`}}
                                >
                                    <TableCell className="font-medium text-slate-700 dark:text-slate-300">
                                        <div className="flex flex-col">
                                            <span
                                                className="text-sm">{format(new Date(transaction.transaction_date), "MMM dd, yyyy")}</span>
                                            <span
                                                className="text-xs text-muted-foreground">{format(new Date(transaction.transaction_date), "EEEE")}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="max-w-xs">
                                        <div className="flex flex-col">
                                            <span
                                                className="font-medium text-slate-900 dark:text-white truncate">{transaction.description}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge
                                            variant="secondary"
                                            className={`${getCategoryColor(transaction.category)} font-medium border capitalize`}
                                        >
                                            {transaction.category}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                    <span className="text-sm text-slate-600 dark:text-slate-400 font-medium">
                      {transaction.bank_source || "-"}
                    </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                    <span
                        className={`text-sm font-bold ${transaction.amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {transaction.amount >= 0 ? '+' : ''}€{Math.abs(transaction.amount).toFixed(2)}
                    </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => handleDelete(transaction.id)}
                                            className="h-8 w-8 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-900/30 dark:hover:text-rose-400 transition-colors"
                                        >
                                            <Trash2 className="h-4 w-4"/>
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
        </Card>
    );
}