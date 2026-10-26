// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { CsvDropzone } from "../CsvDropzone";
import { must } from "@/features/testing/must";

describe("CsvDropzone workbook opt-in", () => {
    it("keeps a bank CSV picker from accepting a workbook", () => {
        const onFileSelect = vi.fn();
        const { container } = renderWithApp(
            <CsvDropzone file={null} onFileSelect={onFileSelect} />,
        );
        const input = must(container.querySelector('input[type="file"]'));
        expect(input).toHaveAttribute("accept", ".csv");
        fireEvent.change(input, {
            target: { files: [new File(["fixture"], "statement.xlsx")] },
        });
        expect(onFileSelect).not.toHaveBeenCalled();
    });

    it("accepts XLSX but no legacy XLS when the portfolio caller enables workbooks", () => {
        const onFileSelect = vi.fn();
        const { container } = renderWithApp(
            <CsvDropzone
                file={null}
                onFileSelect={onFileSelect}
                allowWorkbook
            />,
        );
        const input = must(container.querySelector('input[type="file"]'));
        const file = new File(["fixture"], "statement.xlsx");
        expect(input).toHaveAttribute("accept", ".csv,.xlsx");
        fireEvent.change(input, {
            target: { files: [new File(["fixture"], "legacy.xls")] },
        });
        expect(onFileSelect).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { files: [file] } });
        expect(onFileSelect).toHaveBeenCalledWith(file);
    });
});
