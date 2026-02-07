/**
 * Transactions table component with editing capabilities
 * Uses TanStack Table for powerful table functionality
 */

import {useState} from 'react';
import {
    type ColumnDef,
    type ColumnFiltersState,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    type SortingState,
    useReactTable,
} from '@tanstack/react-table';
import {format} from 'date-fns';
import {ArrowUpDown, Check, Edit2, Trash2, X} from 'lucide-react';
import type {Transaction, TransactionUpdate} from '@/types/api';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow,} from '@/components/ui/table';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface TransactionsTableProps {
    transactions: Transaction[];
    onUpdate: (id: number, update: TransactionUpdate) => void;
    onDelete: (id: number) => void;
    isLoading?: boolean;
}

export function TransactionsTable({
                                      transactions,
                                      onUpdate,
                                      onDelete,
                                      isLoading = false,
                                  }: TransactionsTableProps) {
    const [sorting, setSorting] = useState<SortingState>([
        {id: 'transaction_date', desc: true},
    ]);
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [deleteId, setDeleteId] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Partial<Transaction>>({});

    const startEditing = (transaction: Transaction) => {
        setEditingId(transaction.id);
        setEditValues(transaction);
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditValues({});
    };

    const saveEditing = () => {
        if (editingId && editValues) {
            const update: TransactionUpdate = {
                description: editValues.description,
                amount: editValues.amount,
            };
            onUpdate(editingId, update);
            cancelEditing();
        }
    };

    const columns: ColumnDef<Transaction>[] = [
        {
            accessorKey: 'transaction_date',
            header: ({column}) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                        className="hover:bg-gray-100"
                    >
                        Date
                        <ArrowUpDown className="ml-2 h-4 w-4"/>
                    </Button>
                );
            },
            cell: ({row}) => {
                const date = row.getValue('transaction_date') as string;
                return format(new Date(date), 'dd/MM/yyyy');
            },
        },
        {
            accessorKey: 'description',
            header: ({column}) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                        className="hover:bg-gray-100"
                    >
                        Description
                        <ArrowUpDown className="ml-2 h-4 w-4"/>
                    </Button>
                );
            },
            cell: ({row}) => {
                const isEditing = editingId === row.original.id;
                return isEditing ? (
                    <Input
                        value={editValues.description || ''}
                        onChange={(e) =>
                            setEditValues((prev) => ({...prev, description: e.target.value}))
                        }
                        className="max-w-[300px]"
                    />
                ) : (
                    <div className="max-w-[300px] truncate">{row.getValue('description')}</div>
                );
            },
        },
        {
            accessorKey: 'recipient_name',
            header: 'Recipient',
            cell: ({row}) => {
                return (
                    <div className="max-w-[200px] truncate">{row.getValue('recipient_name')}</div>
                );
            },
        },
        {
            accessorKey: 'amount',
            header: ({column}) => {
                return (
                    <Button
                        variant="ghost"
                        onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
                        className="hover:bg-gray-100"
                    >
                        Amount
                        <ArrowUpDown className="ml-2 h-4 w-4"/>
                    </Button>
                );
            },
            cell: ({row}) => {
                const isEditing = editingId === row.original.id;
                const amount = parseFloat(row.getValue('amount'));
                const currency = row.original.currency || 'EUR';

                return isEditing ? (
                    <Input
                        type="number"
                        step="0.01"
                        value={editValues.amount || 0}
                        onChange={(e) =>
                            setEditValues((prev) => ({...prev, amount: parseFloat(e.target.value)}))
                        }
                        className="max-w-[120px]"
                    />
                ) : (
                    <div className={`font-medium ${amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: currency,
                        }).format(amount)}
                    </div>
                );
            },
        },
        {
            accessorKey: 'category_general',
            header: 'Category',
            cell: ({row}) => {
                const general = row.getValue('category_general') as string | undefined;
                const detail = row.original.category_detail;

                if (!general) {
                    return <span className="text-gray-400 italic">Uncategorised</span>;
                }

                return (
                    <div className="max-w-[150px]">
                        <div className="font-medium">{general}</div>
                        {detail && <div className="text-xs text-gray-500">{detail}</div>}
                    </div>
                );
            },
        },
        {
            accessorKey: 'bank_account',
            header: 'Bank Account',
            cell: ({row}) => {
                const account = row.getValue('bank_account') as string;
                return <div className="max-w-[150px] truncate text-sm">{account}</div>;
            },
        },
        {
            id: 'actions',
            header: 'Actions',
            cell: ({row}) => {
                const isEditing = editingId === row.original.id;

                return (
                    <div className="flex gap-2">
                        {isEditing ? (
                            <>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={saveEditing}
                                    className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                                >
                                    <Check className="h-4 w-4"/>
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={cancelEditing}
                                    className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                                >
                                    <X className="h-4 w-4"/>
                                </Button>
                            </>
                        ) : (
                            <>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => startEditing(row.original)}
                                    className="h-8 w-8 hover:bg-blue-50 hover:text-blue-600"
                                >
                                    <Edit2 className="h-4 w-4"/>
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setDeleteId(row.original.id)}
                                    className="h-8 w-8 hover:bg-red-50 hover:text-red-600"
                                >
                                    <Trash2 className="h-4 w-4"/>
                                </Button>
                            </>
                        )}
                    </div>
                );
            },
        },
    ];

    const table = useReactTable({
        data: transactions,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        state: {
            sorting,
            columnFilters,
        },
        initialState: {
            pagination: {
                pageSize: 10,
            },
        },
    });

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-4">
                <Input
                    placeholder="Filter by description..."
                    value={(table.getColumn('description')?.getFilterValue() as string) ?? ''}
                    onChange={(event) =>
                        table.getColumn('description')?.setFilterValue(event.target.value)
                    }
                    className="max-w-sm"
                />
            </div>

            <div className="rounded-md border bg-white">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <TableHead key={header.id}>
                                        {header.isPlaceholder
                                            ? null
                                            : flexRender(
                                                header.column.columnDef.header,
                                                header.getContext()
                                            )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {isLoading ? (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    Loading transactions...
                                </TableCell>
                            </TableRow>
                        ) : table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && 'selected'}
                                    className="hover:bg-gray-50"
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No transactions found.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>

            <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                    Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
                    {Math.min(
                        (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                        table.getFilteredRowModel().rows.length
                    )}{' '}
                    of {table.getFilteredRowModel().rows.length} transactions
                </div>
                <div className="flex items-center space-x-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                    >
                        Next
                    </Button>
                </div>
            </div>

            <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This action cannot be undone. This will permanently delete the transaction.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (deleteId) {
                                    onDelete(deleteId);
                                    setDeleteId(null);
                                }
                            }}
                            className="bg-red-600 hover:bg-red-700"
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
