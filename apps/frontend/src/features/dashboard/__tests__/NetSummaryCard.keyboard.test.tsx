// @vitest-environment jsdom
/**
 * Keyboard access to the NetSummaryCard sparkline scrub (TODO: "Per-point
 * chart values are unreachable without a pointer"). The scrub div is focusable
 * and ←/→ · Home/End · Escape drive the same scrubIndex the pointer drag does,
 * so the existing month readout updates.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { NetSummaryCard } from "@/features/dashboard/NetSummaryCard";

const HISTORY = [
    { year: 2025, month: 1, net: 100 },
    { year: 2025, month: 2, net: -50 },
    { year: 2025, month: 3, net: 250 },
];

function renderCard() {
    return renderWithApp(
        <NetSummaryCard netBalance={250} income={1000} spending={750} history={HISTORY} />,
    );
}

async function findScrubGroup() {
    return await screen.findByRole("group", { name: /net trend/i });
}

describe("NetSummaryCard sparkline keyboard scrub", () => {
    it("is focusable and arrow keys scrub through months (readout shows the month)", async () => {
        renderCard();
        const group = await findScrubGroup();
        expect(group).toHaveAttribute("tabindex", "0");

        const readout = group.querySelector("p");
        expect(readout?.textContent).toMatch(/net trend/i);

        fireEvent.keyDown(group, { key: "ArrowRight" });
        await waitFor(() => expect(group.querySelector("p")?.textContent).toMatch(/2025/));
        const first = group.querySelector("p")?.textContent;

        fireEvent.keyDown(group, { key: "End" });
        await waitFor(() => {
            const label = group.querySelector("p")?.textContent;
            expect(label).toMatch(/2025/);
            expect(label).not.toBe(first);
        });
    });

    it("Escape and blur clear the scrub back to the trend label", async () => {
        renderCard();
        const group = await findScrubGroup();

        fireEvent.keyDown(group, { key: "ArrowRight" });
        await waitFor(() => expect(group.querySelector("p")?.textContent).toMatch(/2025/));
        fireEvent.keyDown(group, { key: "Escape" });
        await waitFor(() => expect(group.querySelector("p")?.textContent).toMatch(/net trend/i));

        fireEvent.keyDown(group, { key: "ArrowRight" });
        await waitFor(() => expect(group.querySelector("p")?.textContent).toMatch(/2025/));
        fireEvent.blur(group);
        await waitFor(() => expect(group.querySelector("p")?.textContent).toMatch(/net trend/i));
    });
});
