/**
 * useDataTableColumns hook tests.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDataTableColumns } from "./useDataTableColumns";
import type { Column } from "@/types/dataTable";

interface Row {
  id: number;
  name: string;
}

const makeColumns = (): Column<Row>[] => [
  { key: "id", header: "ID", sortable: true },
  { key: "name", header: "Name", filterable: true },
];

describe("useDataTableColumns", () => {
  it("returns the columns from the factory", () => {
    const { result } = renderHook(() =>
      useDataTableColumns<Row>(makeColumns, []),
    );

    expect(result.current).toHaveLength(2);
    expect(result.current[0].key).toBe("id");
    expect(result.current[1].key).toBe("name");
  });

  it("returns a stable reference when deps are unchanged", () => {
    const { result, rerender } = renderHook(() =>
      useDataTableColumns<Row>(makeColumns, []),
    );

    const ref1 = result.current;
    rerender();
    const ref2 = result.current;

    expect(ref1).toBe(ref2);
  });

  it("recomputes when deps change", () => {
    let label = "Name";
    const { result, rerender } = renderHook(() =>
      useDataTableColumns<Row>(
        () => [{ key: "name", header: label }],
        [label],
      ),
    );

    const ref1 = result.current;
    expect(ref1[0].header).toBe("Name");

    label = "Naam";
    rerender();

    const ref2 = result.current;
    expect(ref2[0].header).toBe("Naam");
    expect(ref1).not.toBe(ref2);
  });

  it("factory is only called once when deps are stable", () => {
    const factory = vi.fn(makeColumns);

    const { rerender } = renderHook(() =>
      useDataTableColumns<Row>(factory, []),
    );
    rerender();
    rerender();

    // useMemo calls factory once on mount; stable deps = no further calls
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("supports all Column fields including render and className", () => {
    const { result } = renderHook(() =>
      useDataTableColumns<Row>(
        () => [
          {
            key: "name",
            header: "Name",
            editable: true,
            type: "text",
            render: (row) => row.name,
            className: "text-left",
            minWidth: 80,
            defaultWidth: 200,
            sortable: false,
            filterable: false,
          },
        ],
        [],
      ),
    );

    const col = result.current[0];
    expect(col.editable).toBe(true);
    expect(col.type).toBe("text");
    expect(typeof col.render).toBe("function");
    expect(col.className).toBe("text-left");
    expect(col.minWidth).toBe(80);
    expect(col.defaultWidth).toBe(200);
    expect(col.sortable).toBe(false);
    expect(col.filterable).toBe(false);
  });
});
