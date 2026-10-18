// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { useReportDialogState } from "@/features/reports/useReportDialogState";
import { ExportDialog } from "@/features/reports/ExportDialog";

function Probe() {
    const state = useReportDialogState();
    const location = useLocation();
    return <>
        <output data-testid="route">{location.pathname}{location.search}</output>
        <output data-testid="open">{String(state.exportOpen)}</output>
        <button onClick={() => state.setExportOpen(true)}>Open report</button>
        <button onClick={() => state.setExportOpen(false)}>Close report</button>
    </>;
}

afterEach(() => {
    Reflect.deleteProperty(window, "__VISION_NATIVE_REPORTS__");
});

describe("report URL native handoff and retained web fallback", () => {
    it("opens native reports through the URL and preserves unrelated filters when closing", () => {
        Object.defineProperty(window, "__VISION_NATIVE_REPORTS__", { value: true, configurable: true });
        render(<MemoryRouter initialEntries={["/portfolio/stocks?tab=holdings&keep=2"]}><Probe /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Open report" }));
        expect(screen.getByTestId("route")).toHaveTextContent("/portfolio/stocks?tab=holdings&keep=2&export=pdf");
        expect(screen.getByTestId("open")).toHaveTextContent("true");
        fireEvent.click(screen.getByRole("button", { name: "Close report" }));
        expect(screen.getByTestId("route")).toHaveTextContent("/portfolio/stocks?tab=holdings&keep=2");
        expect(screen.getByTestId("open")).toHaveTextContent("false");
    });

    it("retains local web modal state and existing URL deep-link dismissal without the flag", () => {
        const first = render(<MemoryRouter initialEntries={["/statistics?keep=2"]}><Probe /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Open report" }));
        expect(screen.getByTestId("route")).toHaveTextContent("/statistics?keep=2");
        expect(screen.getByTestId("open")).toHaveTextContent("true");
        first.unmount();
        render(<MemoryRouter initialEntries={["/tax?year=2025&export=pdf&keep=2"]}><Probe /></MemoryRouter>);
        expect(screen.getByTestId("open")).toHaveTextContent("true");
        fireEvent.click(screen.getByRole("button", { name: "Close report" }));
        expect(screen.getByTestId("route")).toHaveTextContent("/tax?year=2025&keep=2");
    });

    it.each(["financial", "portfolio", "tax"] as const)("skips web %s export hooks and controls under the matching Reports flag", (defaultType) => {
        Object.defineProperty(window, "__VISION_NATIVE_REPORTS__", { value: true, configurable: true });
        const view = render(<ExportDialog open defaultType={defaultType} />);
        // An enabled native Reports graph requires no web tax/settings providers.
        expect(view.container).toBeEmptyDOMElement();
    });
});
