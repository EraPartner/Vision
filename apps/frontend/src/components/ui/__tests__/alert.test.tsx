// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, AlertDescription } from "@/components/ui/alert";

describe("Alert roles", () => {
    it("interrupts only when destructive and lets callers override", () => {
        render(
            <>
                <Alert>
                    <AlertDescription>Saved</AlertDescription>
                </Alert>
                <Alert variant="warning">
                    <AlertDescription>Stale</AlertDescription>
                </Alert>
                <Alert variant="destructive">
                    <AlertDescription>Failed</AlertDescription>
                </Alert>
                <Alert variant="warning" role="alert">
                    <AlertDescription>Urgent</AlertDescription>
                </Alert>
            </>,
        );
        expect(screen.getAllByRole("status")).toHaveLength(2);
        expect(screen.getAllByRole("alert").map((n) => n.textContent)).toEqual([
            "Failed",
            "Urgent",
        ]);
    });
});
