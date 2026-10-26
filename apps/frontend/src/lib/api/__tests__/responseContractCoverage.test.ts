/**
 * Coverage ratchet for response contracts (ADR-193, ADR-194).
 *
 * Every non-DELETE `apiRequest` / `requestWithQuery` call in a domain client
 * must pass a `schema`, so contract drift between the backend and the typed
 * result fails the request (and the MSW and live-contract suites) instead of
 * flowing into the UI. The calls below predate the rule or validate their
 * result by another route. The list may only shrink: adding a schema to a call
 * listed here makes the stale entry fail, and a new unchecked call fails too.
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../*.ts", "!../*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
});

const KNOWN_UNCHECKED = new Set([
    "admin.ts POST '/api/admin/database/vacuum'",
    'ai.ts POST "/api/ai/model/release"',
    'ai.ts POST "/api/ai/model/warm"',
    'analysis.ts POST "/api/analysis/extensions/evaluate"',
    "analysis.ts POST `/api/analysis/cancel/${encodeURIComponent(requestId)}`",
    "categories.ts PATCH `/api/categories/${id}`",
    "categories.ts PATCH `/api/categories/tree/${id}`",
    'categories.ts POST "/api/categories/tree"',
    "categories.ts POST `/api/categories/tree/${sourceId}/merge`",
    'electron.ts GET "/api/admin/update/check"',
    "imports.ts PATCH `/api/import/parsers/${id}`",
    'imports.ts POST "/api/import/parsers"',
    "imports.ts POST `/api/import/batches/${batchId}/rows/${rowId}/category-override`",
    "imports.ts POST `/api/import/batches/${batchId}/rows/${rowId}/override`",
    'info.ts PUT "/api/info/insight-dismissals"',
    "monitors.ts PATCH path(id)",
    "monitors.ts POST `${base}/notifications/${encodeURIComponent(id)}/read`",
    'portfolioExposure.ts PUT "/api/investments/exposure/sources"',
    // Parsed with a local zod schema right after the call.
    "portfolioImports.ts GET `/api/portfolio/import/batches?limit=${pagination.limit}&offset=${pagination.offset}`",
    'portfolioImports.ts POST "/api/portfolio/import/reconciliation/commit"',
    'portfolioImports.ts POST "/api/portfolio/import/reconciliation/preview"',
    "recipients.ts PATCH `/api/recipients/${id}`",
    "recipients.ts PATCH `/api/recipients/${recipientId}/patterns/${patternId}`",
    "recipients.ts POST `/api/recipients/${id}/unmerge`",
    "recipients.ts POST `/api/recipients/${recipientId}/patterns`",
    "splits.ts POST '/api/splits/batch'",
    "splits.ts POST `/api/splits/${splitId}/pay`",
    "splits.ts POST `/api/splits/${splitId}/settle`",
    "tags.ts PATCH `/api/tags/${id}`",
    "tags.ts POST '/api/tags'",
    "tags.ts POST '/api/transactions/bulk-tag'",
    // Checked with checkResponseContract after a field guard.
    'transactions.ts GET "/api/transactions"',
    'transactions.ts POST "/api/transactions/transfers"',
]);

interface Call {
    key: string;
    hasSchema: boolean;
    method: string;
}

/** Index of the `)` closing the call whose `(` is at `open`; strings are skipped. */
function closingParen(text: string, open: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) return i;
    }
    return text.length;
}

/** First top-level argument of a call body. */
function firstArgument(args: string): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < args.length; i++) {
        const ch = args[i] ?? "";
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        else if (ch === "," && depth === 0) return args.slice(0, i).trim();
    }
    return args.trim();
}

function findCalls(file: string, text: string): Call[] {
    const calls: Call[] = [];
    const callStart =
        /\b(?:apiRequest|requestWithQuery)\s*(?:<[^()]*?>)?\s*\(/g;
    for (const match of text.matchAll(callStart)) {
        const open = match.index + match[0].length - 1;
        const prefix = text.slice(Math.max(0, match.index - 30), match.index);
        // Skip the declarations of the helpers themselves.
        if (/function\s+$/.test(prefix)) continue;
        const args = text.slice(open + 1, closingParen(text, open));
        const endpoint = firstArgument(args);
        if (endpoint.startsWith("endpoint")) continue; // generic wrapper
        const method =
            /method:\s*["'](\w+)["']/.exec(args)?.[1]?.toUpperCase() ?? "GET";
        calls.push({
            key: `${file} ${method} ${endpoint}`,
            hasSchema: /\bschema\b/.test(args),
            method,
        });
    }
    return calls;
}

describe("response contract coverage", () => {
    const all = Object.entries(sources).flatMap(([path, text]) =>
        findCalls(path.replace("../", ""), text),
    );
    const unchecked = all.filter(
        (call) => !call.hasSchema && call.method !== "DELETE",
    );

    it("scans the domain clients", () => {
        expect(all.length).toBeGreaterThan(150);
    });

    it("has no unchecked call outside the known list", () => {
        const fresh = unchecked
            .map((call) => call.key)
            .filter((key) => !KNOWN_UNCHECKED.has(key));
        expect(fresh, "pass a `schema` from @vision/types/contracts").toEqual(
            [],
        );
    });

    it("keeps the known list free of stale entries", () => {
        const live = new Set(unchecked.map((call) => call.key));
        const stale = [...KNOWN_UNCHECKED].filter((key) => !live.has(key));
        expect(stale, "remove entries that now carry a schema").toEqual([]);
    });

    it("flags a call that has no schema (self-test)", () => {
        const calls = findCalls(
            "x.ts",
            'apiRequest<A>("/a", { method: "POST" });\n' +
                "apiRequest<B>(`/b/${id}`, { schema: S });\n" +
                'apiRequest("/c", { method: "DELETE" });',
        );
        expect(calls.map((c) => [c.key, c.hasSchema])).toEqual([
            ['x.ts POST "/a"', false],
            ["x.ts GET `/b/${id}`", true],
            ['x.ts DELETE "/c"', false],
        ]);
    });
});
