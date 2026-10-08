// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    Inspector,
    InspectorBody,
    InspectorClose,
    InspectorField,
    InspectorHeader,
    InspectorSection,
    InspectorTitle,
} from "@/components/ui/inspector";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({
        t: (key: string) => (key === "common.close" ? "Close" : key),
    }),
}));

function renderInspector(onClose = vi.fn()) {
    render(
        <Inspector aria-label="Transaction details" onClose={onClose}>
            <InspectorHeader>
                <InspectorTitle>Delhaize Gent</InspectorTitle>
                <InspectorClose onClick={onClose} />
            </InspectorHeader>
            <InspectorBody>
                <InspectorSection label="Details">
                    <dl>
                        <InspectorField label="Amount">-42,10 €</InspectorField>
                    </dl>
                </InspectorSection>
            </InspectorBody>
        </Inspector>,
    );
    return onClose;
}

describe("Inspector", () => {
    it("is a complementary landmark, not a dialog", () => {
        renderInspector();
        const panel = screen.getByRole("complementary", {
            name: "Transaction details",
        });
        expect(panel).toHaveClass("rounded-card", "corner-continuous");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
            screen.getByRole("heading", { name: "Delhaize Gent" }),
        ).toBeInTheDocument();
        expect(screen.getByText("Amount")).toBeInTheDocument();
    });

    it("closes from its close button and from Escape inside the panel", () => {
        const onClose = renderInspector();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(
            screen.getByRole("heading", { name: "Delhaize Gent" }),
            {
                key: "Escape",
            },
        );
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
