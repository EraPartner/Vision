/**
 * Shared DataTable column definition.
 *
 * Used by both DataTable and VirtualDataTable so the type is defined once and
 * callers can use the same `Column<T>` interface without importing from a
 * specific component file.
 */

import type React from "react";

export interface Column<T> {
  /** Unique key — used for sort state, filter state, and column width tracking. */
  key: string;
  /** Column header label. */
  header: string;
  /** Whether the cell is inline-editable. */
  editable?: boolean;
  /** Hint for the inline editor input type. */
  type?: "text" | "number" | "date";
  /**
   * Custom render function.
   * @param row        The data row.
   * @param isEditing  True when the row is in edit mode.
   * @param index      Zero-based row index within the visible set.
   */
  render?: (row: T, isEditing: boolean, index?: number) => React.ReactNode;
  /** Extra className applied to every cell in this column. */
  className?: string;
  /** Minimum resizable width in pixels. */
  minWidth?: number;
  /** Initial width in pixels before the user resizes. */
  defaultWidth?: number;
  /** Allow sorting by this column. Defaults to true when a header is set. */
  sortable?: boolean;
  /** Allow column-level filtering. Defaults to true when a header is set. */
  filterable?: boolean;
}
