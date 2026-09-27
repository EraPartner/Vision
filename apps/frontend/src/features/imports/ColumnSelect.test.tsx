// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MappedColumnField } from "./ColumnSelect";

describe("CSV mapping field accessibility", () => {
    it.each([false, true])(
        "announces required status with headers=%s",
        (hasHeaders) => {
            render(
                <MappedColumnField
                    id="date-column"
                    label="Date column"
                    value=""
                    headers={hasHeaders ? ["Date"] : []}
                    hasHeaders={hasHeaders}
                    required
                    onChange={vi.fn()}
                    noMappingLabel="Leave empty"
                />,
            );

            const field = screen.getByRole(
                hasHeaders ? "combobox" : "textbox",
                {
                    name: "Date column",
                },
            );
            expect(field).toHaveAttribute("aria-required", "true");
            expect(screen.getByText("*")).toHaveAttribute(
                "aria-hidden",
                "true",
            );
        },
    );
});
