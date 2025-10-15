import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Trash2 } from "lucide-react";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";

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

const categoryColors: Record<string, string> = {
  groceries: "bg-blue-500/10 text-blue-500 hover:bg-blue-500/20",
  dining: "bg-orange-500/10 text-orange-500 hover:bg-orange-500/20",
  transportation: "bg-purple-500/10 text-purple-500 hover:bg-purple-500/20",
  utilities: "bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20",
  entertainment: "bg-pink-500/10 text-pink-500 hover:bg-pink-500/20",
  healthcare: "bg-red-500/10 text-red-500 hover:bg-red-500/20",
  shopping: "bg-green-500/10 text-green-500 hover:bg-green-500/20",
  income: "bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20",
  other: "bg-gray-500/10 text-gray-500 hover:bg-gray-500/20",
};

export function TransactionsTable({ transactions, onTransactionDeleted }: TransactionsTableProps) {
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
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Bank</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                No transactions yet. Import your first CSV file to get started!
              </TableCell>
            </TableRow>
          ) : (
            transactions.map((transaction) => (
              <TableRow key={transaction.id}>
                <TableCell className="font-medium">
                  {format(new Date(transaction.transaction_date), "MMM dd, yyyy")}
                </TableCell>
                <TableCell>{transaction.description}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className={categoryColors[transaction.category]}>
                    {transaction.category}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{transaction.bank_source || "-"}</TableCell>
                <TableCell className={`text-right font-medium ${transaction.amount < 0 ? 'text-destructive' : 'text-green-600'}`}>
                  {transaction.amount >= 0 ? '+' : ''}${Math.abs(transaction.amount).toFixed(2)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(transaction.id)}
                    className="h-8 w-8"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}