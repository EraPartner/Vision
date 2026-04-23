/**
 * useDataTableColumns — memoized column definition factory for DataTable and
 * VirtualDataTable.
 *
 * Wraps column definitions in `useMemo` so they are stable across renders.
 * Without memoization, inline column arrays cause the table to re-render every
 * time the parent renders, even when the data is unchanged.
 *
 * Usage:
 *   const columns = useDataTableColumns<Transaction>(() => [
 *     { key: 'date', header: t('col.date'), render: (row) => row.date },
 *     { key: 'amount', header: t('col.amount'), sortable: true },
 *   ], [t]);
 */

import { useMemo } from "react";
import type { Column } from "@/types/dataTable";

/**
 * Return a stable, memoized array of column definitions.
 *
 * @param factory  Function that returns the column array. Called only when
 *                 `deps` change — same contract as `useMemo`.
 * @param deps     Dependency array forwarded to `useMemo`.
 * @returns        Stable `Column<T>[]` reference.
 */
export function useDataTableColumns<T>(
  factory: () => Column<T>[],
  deps: React.DependencyList,
): Column<T>[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}
