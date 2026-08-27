// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { AlertTriangle } from "lucide-react";
import { describe, expect, it } from "vitest";

import { StateBlock } from "@/components/shared/StateBlock";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

describe("page heading semantics", () => {
    it("uses h2 for page-level card and state headings", () => {
        render(
            <>
                <h1>Page title</h1>
                <Card>
                    <CardHeader>
                        <CardTitle>Panel title</CardTitle>
                    </CardHeader>
                </Card>
                <StateBlock icon={AlertTriangle} title="Empty page" />
            </>,
        );

        expect(
            screen.getByRole("heading", { name: "Panel title", level: 2 }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Empty page", level: 2 }),
        ).toBeInTheDocument();
    });

    it("supports explicit nested h3 and h4 card titles", () => {
        render(
            <>
                <CardTitle level={3}>Nested section</CardTitle>
                <CardTitle level={4}>Deep section</CardTitle>
            </>,
        );

        expect(
            screen.getByRole("heading", { name: "Nested section", level: 3 }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Deep section", level: 4 }),
        ).toBeInTheDocument();
    });
});
