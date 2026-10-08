// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import PortfolioImportPage from "../PortfolioImportPage";

it("starts with file selection and reveals mappings after choosing a CSV", async () => {
    server.use(
        http.get("http://localhost:3002/api/portfolio/import/parsers", () =>
            ok({ items: [], total: 0 }),
        ),
    );
    const user = userEvent.setup();
    renderWithApp(<PortfolioImportPage />);
    expect(
        await screen.findByLabelText("Statements (CSV or XLSX)"),
    ).toHaveAttribute("multiple");
    expect(
        screen.getByText("Advanced single-file import").closest("details"),
    ).not.toHaveAttribute("open");
    await user.click(screen.getByText("Advanced single-file import"));
    expect(await screen.findByText("Transaction history file")).toBeVisible();
    expect(screen.queryByLabelText(/Date column/)).not.toBeInTheDocument();
    const input = screen
        .getByText("Advanced single-file import")
        .closest("details")!
        .querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).toHaveAttribute("accept", ".csv,.xlsx,.xls");
    expect(screen.getByRole("combobox", { name: "Parser" })).toHaveTextContent(
        "Detect automatically",
    );
    await user.upload(
        input,
        new File(["Date,Symbol,Amount\n2026-01-01,AAPL,100"], "trades.csv", {
            type: "text/csv",
        }),
    );
    await waitFor(() => {
        const dateColumn = screen.getByLabelText(/Date column/);
        expect(dateColumn).toBeVisible();
        expect(dateColumn).toHaveAttribute("role", "combobox");
    });
    expect(
        screen.getByText("Additional columns").closest("details"),
    ).not.toHaveAttribute("open");
    expect(
        screen.getByText("CSV format options").closest("details"),
    ).not.toHaveAttribute("open");
});
