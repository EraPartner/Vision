import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const typeAwareConfigUrl = new URL(
    "../../../../config/eslint-type-aware.mjs",
    import.meta.url,
).href;
const { typeAwareRules } = (await import(typeAwareConfigUrl)) as {
    typeAwareRules: Record<string, unknown>;
};
// The fixtures below are virtual files the TypeScript project service cannot
// see, so lint them without type information; the guards under test are
// syntactic and do not need it.
const eslint = new ESLint({
    cwd: frontendRoot,
    overrideConfig: {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            parserOptions: { projectService: false, project: null },
        },
        rules: Object.fromEntries(
            Object.keys(typeAwareRules).map((rule) => [rule, "off"]),
        ),
    },
});

async function lintFixture(source: string, filePath: string) {
    const [result] = await eslint.lintText(source, { filePath });
    if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
    const fatal = result.messages.find((message) => message.fatal);
    if (fatal) throw new Error(`ESLint could not parse ${filePath}: ${fatal.message}`);
    return result;
}

async function i18nWarnings(source: string, filePath: string) {
    const result = await lintFixture(source, filePath);
    return result.messages.filter(
        ({ ruleId }) =>
            ruleId === "vision-i18n/no-hardcoded-user-facing-string",
    );
}

async function inlineQueryErrors(source: string, filePath: string) {
    const result = await lintFixture(source, filePath);
    return result.messages.filter(
        ({ ruleId }) => ruleId === "vision-query/no-inline-server-query",
    );
}

describe("frontend ESLint i18n guard", () => {
    it("warns for static rendered text in direct and expression forms", async () => {
        const warnings = await i18nWarnings(
            `export function Fixture() {
                return <>
                    <p>Direct text</p>
                    <p>{"Expression text"}</p>
                    <p>{\`Template text\`}</p>
                    <input aria-label="Direct label" placeholder={"Expression placeholder"} />
                    <p>{t("translated.key")}</p>
                </>;
            }`,
            `${frontendRoot}/src/components/LintFixture.tsx`,
        );

        expect(warnings.map(({ message }) => message)).toHaveLength(5);
    });

    it("does not lint test-fixture copy", async () => {
        const warnings = await i18nWarnings(
            `export function Fixture() { return <p>Fixture text</p>; }`,
            `${frontendRoot}/src/components/__tests__/LintFixture.test.tsx`,
        );

        expect(warnings).toHaveLength(0);
    });
});

describe("frontend inline server-query guard", () => {
    it("rejects direct, aliased, and namespace query hooks in UI modules", async () => {
        const errors = await inlineQueryErrors(
            `import { useQuery, useQueries as many } from "@tanstack/react-query";
             import * as ReactQuery from "@tanstack/react-query";
             export function Fixture() {
               useQuery({ queryKey: ["one"], queryFn: async () => 1 });
               many({ queries: [] });
               ReactQuery.useInfiniteQuery({ queryKey: ["more"], queryFn: async () => 1, initialPageParam: 0, getNextPageParam: () => undefined });
               return null;
             }`,
            `${frontendRoot}/src/components/LintFixture.tsx`,
        );
        expect(errors).toHaveLength(3);
    });

    it("allows query hooks in named hook modules and test files", async () => {
        const source = `import { useQuery } from "@tanstack/react-query";
            export function useFixture() { return useQuery({ queryKey: ["one"], queryFn: async () => 1 }); }`;
        expect(
            await inlineQueryErrors(
                source,
                `${frontendRoot}/src/features/example/useFixture.ts`,
            ),
        ).toHaveLength(0);
        expect(
            await inlineQueryErrors(
                source,
                `${frontendRoot}/src/components/__tests__/Fixture.test.tsx`,
            ),
        ).toHaveLength(0);
    });

    it("does not reject useQueryClient", async () => {
        const errors = await inlineQueryErrors(
            `import { useQueryClient } from "@tanstack/react-query";
             export function Fixture() { useQueryClient(); return null; }`,
            `${frontendRoot}/src/pages/LintFixture.tsx`,
        );
        expect(errors).toHaveLength(0);
    });
});
