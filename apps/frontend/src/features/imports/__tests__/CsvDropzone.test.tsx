// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { CsvDropzone } from "../CsvDropzone";

describe("CsvDropzone workbook opt-in", () => {
    it("keeps a bank CSV picker from accepting a legacy funding workbook", () => {
        const onFileSelect = vi.fn();
        const { container } = renderWithApp(
            <CsvDropzone file={null} onFileSelect={onFileSelect} />,
        );
        const input = container.querySelector('input[type="file"]')!;
        expect(input).toHaveAttribute("accept", ".csv");
        fireEvent.change(input, {
            target: { files: [new File(["fixture"], "funding.xls")] },
        });
        expect(onFileSelect).not.toHaveBeenCalled();
    });

    it("accepts XLS only when the portfolio caller explicitly enables legacy funding workbooks", () => {
        const onFileSelect = vi.fn();
        const { container } = renderWithApp(
            <CsvDropzone
                file={null}
                onFileSelect={onFileSelect}
                allowWorkbook
                allowLegacyWorkbook
            />,
        );
        const input = container.querySelector('input[type="file"]')!;
        const file = new File(["fixture"], "funding.xls");
        expect(input).toHaveAttribute("accept", ".csv,.xlsx,.xls");
        fireEvent.change(input, { target: { files: [file] } });
        expect(onFileSelect).toHaveBeenCalledWith(file);
    });
});
