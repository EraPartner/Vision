// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function tsxTree(directory: string): string {
    return readdirSync(directory, { withFileTypes: true })
        .map((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return entry.name === "__tests__" ? "" : tsxTree(path);
            if (entry.name.includes(".test.")) return "";
            return /\.tsx?$/.test(entry.name) ? readFileSync(path, "utf8") : "";
        })
        .join("\n");
}

describe("design-system primitives (ADR-179)", () => {
    it("draws one keyboard focus ring: the base rule, with no forced radius", () => {
        const css = read("index.css");
        const base = css.match(/:focus-visible\s*\{([\s\S]*?)\}/)?.[1] ?? "";
        expect(base).toContain("outline: 3px solid hsl(var(--ring) / var(--focus-ring-alpha))");
        expect(base).toContain("outline-offset: 1px");
        expect(base).not.toContain("border-radius");
    });

    it("has no Tailwind focus ring left in the primitives or the app", () => {
        const source = tsxTree(root);
        expect(source).not.toMatch(/focus-visible:ring-(?:2|ring)/);
        expect(source).not.toContain("ring-offset-background");
    });

    it("spells each motion token one way", () => {
        const source = tsxTree(root);
        expect(source).not.toMatch(/duration-\[var\(--duration-/);
        expect(source).not.toMatch(/ease-\[var\(--ease-/);
    });

    it("sizes controls at 36px regular, 32px small and 40px large", () => {
        const button = read("components/ui/button.tsx");
        expect(button).toContain('default: "h-9 px-4"');
        expect(button).toContain('sm: "h-8 px-3"');
        expect(button).toContain('lg: "h-10 px-6"');
        expect(button).toContain('icon: "h-9 w-9"');
        expect(read("components/ui/input.tsx")).toContain("flex h-9 w-full rounded-control");
        expect(read("components/ui/select.tsx")).toContain("flex h-9 w-full items-center justify-between rounded-control");
        expect(read("components/ui/tabs.tsx")).toContain("inline-flex h-9 max-w-full");
        expect(read("components/ui/toggle.tsx")).toContain('default: "h-9 px-3"');
    });

    it("puts every primitive on the role corner scale, continuous where supported", () => {
        expect(read("components/ui/card.tsx")).toContain("rounded-card corner-continuous");
        for (const file of ["dialog.tsx", "alert-dialog.tsx"]) {
            expect(read(`components/ui/${file}`)).toContain("rounded-sheet corner-continuous");
            expect(read(`components/ui/${file}`)).not.toContain("shadow-glass-elevated");
        }
        expect(read("components/ui/sheet.tsx")).toContain("rounded-r-sheet");
        for (const file of ["popover.tsx", "dropdown-menu.tsx", "context-menu.tsx", "select.tsx"]) {
            expect(read(`components/ui/${file}`)).toContain("rounded-card corner-continuous glass-thick");
        }
        expect(read("components/ui/checkbox.tsx")).toContain("rounded-chip");
        const ui = tsxTree(join(root, "components/ui"));
        expect(ui).not.toMatch(/rounded-\[0\.\d+rem\]|rounded-\[\d+px\]/);
    });

    it("gives the glass tiers their depth from the elevation tokens", () => {
        const css = read("index.css");
        const tier = (selector: string) =>
            css.match(new RegExp(`\\n    ${selector.replace(/[.-]/g, "\\$&")}[^{]*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
        expect(tier(".glass-thin,")).toContain("box-shadow: var(--elevation-1)");
        expect(tier(".glass-regular,")).toContain("box-shadow: var(--elevation-2)");
        expect(tier(".glass-thick {")).toContain("box-shadow: var(--elevation-4)");
        expect(tier(".glass-elevated,")).toContain("box-shadow: var(--elevation-3)");
    });

    it("enters dialogs on the sampled spring and moves the switch thumb on the snappy one", () => {
        expect(read("../tailwind.config.ts")).toContain(
            '"dialog-in": "dialog-in var(--spring-smooth-duration) var(--spring-smooth) both"',
        );
        expect(read("components/ui/switch.tsx")).toContain("duration-spring-snappy ease-spring-snappy");
    });

    it("uses the type and label roles in titles, descriptions and placeholders", () => {
        for (const file of ["dialog.tsx", "alert-dialog.tsx", "sheet.tsx"]) {
            const source = read(`components/ui/${file}`);
            expect(source).toContain('"type-title-2 text-foreground"');
            expect(source).toContain('"type-body text-label-secondary"');
        }
        expect(read("components/ui/input.tsx")).toContain("placeholder:text-label-tertiary");
        expect(read("components/shared/PageHeader.tsx")).toContain("type-large-title");
    });

    it("keeps the delete confirmation while Undo cannot restore everything", () => {
        // Undo re-creates the row without its attachments, splits and planned
        // link (docs/features/transactions.md), so the confirm stays until it can.
        expect(read("pages/TransactionsPage.tsx")).toContain('t("txPage.delete.title")');
        expect(read("hooks/useTransactions.ts")).toContain("undoToast({");
    });
});
