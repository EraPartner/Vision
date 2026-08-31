import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: frontendRoot });

async function i18nWarnings(source: string, filePath: string) {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.filter(
        ({ ruleId }) =>
            ruleId === "vision-i18n/no-hardcoded-user-facing-string",
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
