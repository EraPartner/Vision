// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const MONEY_SURFACES = [
    "src/features/transactions/components/TransactionsTable.tsx",
    "src/features/transactions/components/TransactionQuickLook.tsx",
    "src/features/splits/owes/RecentRecipientTransactionsTable.tsx",
    "src/features/statistics/RecipientInsightsTab.tsx",
] as const;

const SIGNED_MONEY_SURFACES = [
    "src/features/accounts/ReconcileDialog.tsx",
    "src/features/accounts/driftBadge.ts",
    "src/features/planned/ExecutionHistoryDialog.tsx",
    "src/features/planned/LinkTransactionDialog.tsx",
    "src/features/planned/NextSevenDaysStrip.tsx",
    "src/features/planned/PlannedPaymentsTable.tsx",
    "src/features/portfolio/FxPnlCell.tsx",
    "src/features/portfolio/InvestmentDetailDialog.tsx",
    "src/features/portfolio/PerformanceBreakdown.tsx",
    "src/features/portfolio/TotalValueCard.tsx",
    "src/features/statistics/MonthlyRhythm.tsx",
    "src/features/tax/PitBreakdownCard.tsx",
    "src/features/tax/TaxTypesBreakdownCard.tsx",
    "src/features/tax/YearComparisonCard.tsx",
    "src/pages/portfolio/PerformancePage.tsx",
    "src/pages/portfolio/PortfolioOverviewPage.tsx",
    "src/pages/portfolio/RealEstatePage.tsx",
    "src/pages/portfolio/RebalancePage.tsx",
    "src/pages/portfolio/SavingsPage.tsx",
    "src/pages/portfolio/StocksPage.tsx",
    "src/pages/portfolio/net-worth/NetWorthPage.tsx",
    "src/pages/portfolio/net-worth/SnapshotDataTable.tsx",
    "src/pages/portfolio/tax/InvestmentTaxBreakdownTable.tsx",
    "src/pages/research/MarketLookupPage.tsx",
] as const;

const ADOPTED_PAGE_SURFACES = [
    "src/pages/AccountsPage.tsx",
    "src/pages/AccountDetailPage.tsx",
    "src/pages/portfolio/StocksPage.tsx",
    "src/pages/portfolio/PortfolioOverviewPage.tsx",
    "src/pages/portfolio/RealEstatePage.tsx",
    "src/pages/portfolio/SavingsPage.tsx",
    "src/pages/portfolio/RebalancePage.tsx",
    "src/pages/portfolio/net-worth/SnapshotDataTable.tsx",
    "src/pages/portfolio/tax/PortfolioTaxPage.tsx",
    "src/pages/portfolio/tax/InvestmentTaxBreakdownTable.tsx",
] as const;

function parse(relativePath: string): ts.SourceFile {
    return ts.createSourceFile(
        relativePath,
        readFileSync(join(process.cwd(), relativePath), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
}

function classNameContainsMono(
    attributes: ts.JsxAttributes,
    sourceFile: ts.SourceFile,
): boolean {
    return attributes.properties.some(
        (property) =>
            ts.isJsxAttribute(property) &&
            property.name.getText(sourceFile) === "className" &&
            property.initializer?.getText(sourceFile).includes("font-mono"),
    );
}

function hasMonoAncestor(node: ts.Node, sourceFile: ts.SourceFile): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isSourceFile(current)) {
        if (
            ts.isJsxElement(current) &&
            classNameContainsMono(current.openingElement.attributes, sourceFile)
        ) {
            return true;
        }
        current = current.parent;
    }
    return false;
}

function moneyUnderMono(relativePath: string): string[] {
    const sourceFile = parse(relativePath);
    const violations: string[] = [];

    function visit(node: ts.Node): void {
        if (
            ts.isJsxSelfClosingElement(node) &&
            node.tagName.getText(sourceFile) === "Money" &&
            (classNameContainsMono(node.attributes, sourceFile) ||
                hasMonoAncestor(node, sourceFile))
        ) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
            );
            violations.push(`${relativePath}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

function expressionHasMonoAncestor(
    relativePath: string,
    expressionText: string,
): boolean {
    const sourceFile = parse(relativePath);
    let found = false;

    function visit(node: ts.Node): void {
        if (
            ts.isJsxExpression(node) &&
            node.expression?.getText(sourceFile) === expressionText &&
            hasMonoAncestor(node, sourceFile)
        ) {
            found = true;
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return found;
}

describe("money typography contract", () => {
    it("adopts Money on the account, portfolio, net-worth, and tax page surfaces", () => {
        for (const relativePath of ADOPTED_PAGE_SURFACES) {
            const source = readFileSync(
                join(process.cwd(), relativePath),
                "utf8",
            );
            expect(source, relativePath).toContain("<Money");
        }
    });

    it("preserves signed ledger deltas, unsigned balances, native stock currencies, and zero-decimal rebalance values", () => {
        const accountDetail = readFileSync(
            join(process.cwd(), "src/pages/AccountDetailPage.tsx"),
            "utf8",
        );
        expect(accountDetail).toMatch(
            /amount=\{txn\.amount\}[\s\S]*?currency=\{\s*txn\.currency\s*\?\?\s*"EUR"\s*\}[\s\S]*?signed/,
        );
        expect(accountDetail).toMatch(
            /amount=\{\s*txn\.running_balance\s*\}[\s\S]*?currency=\{\s*txn\.currency\s*\?\?\s*"EUR"\s*\}/,
        );

        const stocks = readFileSync(
            join(process.cwd(), "src/pages/portfolio/StocksPage.tsx"),
            "utf8",
        );
        expect(stocks).toMatch(
            /currency=\{\s*priceColumnsInTargetCurrency\s*\?\s*targetCurrency\s*:\s*holdingCurrency\s*\}/,
        );

        const rebalance = readFileSync(
            join(process.cwd(), "src/pages/portfolio/RebalancePage.tsx"),
            "utf8",
        );
        expect(rebalance.match(/fractionDigits=\{\s*0\s*\}/g)).toHaveLength(4);

        const snapshots = readFileSync(
            join(
                process.cwd(),
                "src/pages/portfolio/net-worth/SnapshotDataTable.tsx",
            ),
            "utf8",
        );
        expect(snapshots).toContain("if (row.change === undefined) return '—'");
        expect(snapshots).toContain(
            "amount={row.change} currency={currency} signed",
        );
    });

    it("does not inherit the identifier/code monospace voice", () => {
        expect(MONEY_SURFACES.flatMap(moneyUnderMono)).toEqual([]);
    });

    it("preserves monospace for identifiers", () => {
        expect(
            expressionHasMonoAncestor(
                "src/pages/RecipientsPage.tsx",
                "row.primary_bank_account",
            ),
        ).toBe(true);
        expect(
            expressionHasMonoAncestor(
                "src/components/shared/SymbolSearchResultItem.tsx",
                "item.symbol",
            ),
        ).toBe(true);
    });

    it("routes signed money through Intl-backed shared formatters", () => {
        const violations = SIGNED_MONEY_SURFACES.flatMap((relativePath) => {
            const source = readFileSync(
                join(process.cwd(), relativePath),
                "utf8",
            );
            const hasManualMoneySign = [
                /<Money\s+amount=\{Math\.abs\(/,
                /\{[^}\n]*(?:>=|>|<)[^}\n]*\?\s*["'][+−-]["'][^}\n]*\}\s*<Money/,
                /[+−-]\{(?:fmt|fmtCur)\(/,
                /\{[^}\n]*\?\s*["']\+["'][^}\n]*\}\s*\{(?:fmt|fmtCur)\(/,
                /\$\{[^}]*\?\s*["']\+["'][^}]*\}\$\{fmtCur\(/,
            ].some((pattern) => pattern.test(source));
            return hasManualMoneySign ? [relativePath] : [];
        });

        expect(violations).toEqual([]);
    });

    it("passes raw planned-payment amounts to signed Money", () => {
        for (const [relativePath, amountExpression] of [
            ["src/features/planned/ExecutionHistoryDialog.tsx", "item.amount"],
            ["src/features/planned/LinkTransactionDialog.tsx", "tx.amount"],
            ["src/features/planned/NextSevenDaysStrip.tsx", "p.amount"],
            ["src/features/planned/PlannedPaymentsTable.tsx", "row.amount"],
        ] as const) {
            const source = readFileSync(
                join(process.cwd(), relativePath),
                "utf8",
            );
            expect(source, relativePath).toContain(
                `amount={${amountExpression}}`,
            );
            expect(source, relativePath).toMatch(
                new RegExp(
                    `amount=\\{${amountExpression.replace(".", "\\.")}\\}[^>]*signed`,
                ),
            );
        }
    });

    it("keeps former manual-sign edge cases on signed shared formatters", () => {
        const marketLookup = readFileSync(
            join(process.cwd(), "src/pages/research/MarketLookupPage.tsx"),
            "utf8",
        );
        expect(marketLookup).toMatch(
            /fmtPrice\(\s*quote\.change,\s*quote\.currency,\s*true,?\s*\)/,
        );
        expect(marketLookup).not.toMatch(
            /\?\s*["']\+["']\s*:\s*["']["']\s*}\s*{fmtPrice\(/,
        );

        const monthlyRhythm = readFileSync(
            join(process.cwd(), "src/features/statistics/MonthlyRhythm.tsx"),
            "utf8",
        );
        expect(monthlyRhythm).toContain("formatCompact(delta, true)");
        expect(monthlyRhythm).toContain("label={deltaCompact.display}");
        expect(monthlyRhythm).not.toMatch(
            /\$\{[^}]*\?\s*["']\+["']\s*:\s*["']["'][^}]*}\$\{deltaCompact\.display}/,
        );

        const yearComparison = readFileSync(
            join(process.cwd(), "src/features/tax/YearComparisonCard.tsx"),
            "utf8",
        );
        expect(yearComparison).toMatch(
            /const deltaAmount = row\.isCurrency\s*\?\s*fmtBase\(delta,\s*\{\s*decimals:\s*0,\s*signed:\s*true,?\s*\}\)\s*:\s*row\.format\(Math\.abs\(delta\)\)/,
        );
    });
});
