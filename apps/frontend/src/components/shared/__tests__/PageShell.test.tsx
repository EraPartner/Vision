// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageShell } from "@/components/shared/PageShell";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const pagesRoot = resolve(import.meta.dirname, "../../../pages");
const pageFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory()
            ? pageFiles(path)
            : path.endsWith("Page.tsx")
              ? [path]
              : [];
    });

describe("PageShell", () => {
    it("uses standard page rhythm and forwards div props", () => {
        render(
            <PageShell
                data-testid="shell"
                aria-label="Page content"
                className="max-w-4xl"
            />,
        );
        expect(screen.getByTestId("shell")).toHaveClass(
            "max-w-4xl",
            "space-y-6",
        );
        expect(screen.getByLabelText("Page content")).toBeInTheDocument();
    });

    it("supports the explicit airy dashboard rhythm", () => {
        render(
            <PageShell
                data-testid="shell"
                rhythm="airy"
                className="space-y-2"
            />,
        );
        expect(screen.getByTestId("shell")).toHaveClass("space-y-8");
        expect(screen.getByTestId("shell")).not.toHaveClass("space-y-2");
    });

    it("owns the rhythm of every PageHeader page", () => {
        const failures: string[] = [];
        for (const file of pageFiles(pagesRoot)) {
            const source = readFileSync(file, "utf8");
            if (
                source.includes("<PageHeader") &&
                !source.includes("<PageShell")
            ) {
                failures.push(relative(pagesRoot, file));
            }
            if (
                !file.endsWith("DashboardPage.tsx") &&
                source.includes('rhythm="airy"')
            ) {
                failures.push(`${relative(pagesRoot, file)} uses airy rhythm`);
            }
        }
        expect(failures).toEqual([]);
        expect(
            readFileSync(join(pagesRoot, "DashboardPage.tsx"), "utf8"),
        ).toContain('rhythm="airy"');
    });
});
