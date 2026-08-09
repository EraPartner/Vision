// @vitest-environment jsdom
//
// Enter-to-submit regression tests (TODO.md: "Enter never submits in the
// button-only dialogs"). MarkAsFiledDialog is the simple representative: one
// text input + confirm/cancel footer, now wrapped in a real <form>. Enter in
// the reference field must file the year exactly once; Cancel must never file.
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { MarkAsFiledDialog } from "@/components/tax/MarkAsFiledDialog";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";

const YEAR = 2025;

/**
 * Context probe: renders the filed flag and the count of 'filed' audit entries.
 * The entry count is the double-submit detector — a submit firing twice
 * (button onClick + form onSubmit) would append two history entries.
 */
function FiledProbe() {
    const { isYearFiled, getSnapshotHistory } = useBelgianTaxProfile();
    const filedEntries = getSnapshotHistory(YEAR).filter((e) => e.kind === "filed");
    return (
        <div>
            <span data-testid="filed-state">{isYearFiled(YEAR) ? "filed" : "not-filed"}</span>
            <span data-testid="filed-count">{filedEntries.length}</span>
        </div>
    );
}

async function renderAndOpen(user: ReturnType<typeof userEvent.setup>) {
    renderWithApp(
        <>
            <MarkAsFiledDialog trigger={<button type="button">open filing</button>} year={YEAR} />
            <FiledProbe />
        </>,
    );
    await user.click(await screen.findByRole("button", { name: /open filing/i }));
    await screen.findByText(`Mark ${YEAR} as filed`);
}

describe("MarkAsFiledDialog — Enter submits the form", () => {
    it("files the year exactly once on Enter in the reference field", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "TOW-12345{Enter}");

        await waitFor(() =>
            expect(screen.getByTestId("filed-state")).toHaveTextContent("filed"),
        );
        // Exactly one 'filed' audit entry — no double submit.
        expect(screen.getByTestId("filed-count")).toHaveTextContent("1");
        // Confirm closes the dialog.
        expect(screen.queryByText(`Mark ${YEAR} as filed`)).not.toBeInTheDocument();
    });

    it("clicking the confirm button still files exactly once", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "PAPER-1");
        await user.click(screen.getByRole("button", { name: /mark as filed/i }));

        await waitFor(() =>
            expect(screen.getByTestId("filed-state")).toHaveTextContent("filed"),
        );
        expect(screen.getByTestId("filed-count")).toHaveTextContent("1");
    });

    it("cancel closes without filing", async () => {
        const user = userEvent.setup();
        await renderAndOpen(user);

        await user.type(screen.getByLabelText("Reference"), "SHOULD-NOT-FILE");
        await user.click(screen.getByRole("button", { name: /cancel/i }));

        await waitFor(() =>
            expect(screen.queryByText(`Mark ${YEAR} as filed`)).not.toBeInTheDocument(),
        );
        expect(screen.getByTestId("filed-state")).toHaveTextContent("not-filed");
        expect(screen.getByTestId("filed-count")).toHaveTextContent("0");
    });
});
