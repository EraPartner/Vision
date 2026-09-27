// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import PortfolioImportPage from "../PortfolioImportPage";

it("starts with file selection and reveals mappings after choosing a CSV", async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<PortfolioImportPage />);
    expect(
        await screen.findByText(
            "Choose a CSV file to match its columns to your transactions.",
        ),
    ).toBeVisible();
    expect(screen.queryByLabelText(/Date column/)).not.toBeInTheDocument();
    const input =
        container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
        input,
        new File(["Date,Symbol,Amount\n2026-01-01,AAPL,100"], "trades.csv", {
            type: "text/csv",
        }),
    );
    expect(await screen.findByLabelText(/Date column/)).toBeVisible();
    await waitFor(() =>
        expect(screen.getByLabelText(/Date column/)).toHaveAttribute(
            "role",
            "combobox",
        ),
    );
    expect(
        screen.getByText("Additional columns").closest("details"),
    ).not.toHaveAttribute("open");
    expect(
        screen.getByText("CSV format options").closest("details"),
    ).not.toHaveAttribute("open");
});
