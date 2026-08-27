import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..");

function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory()
            ? filesUnder(path)
            : path.endsWith(".tsx") &&
                !path.includes("/__tests__/") &&
                !path.endsWith(".test.tsx")
              ? [path]
              : [];
    });
}

describe("form label associations", () => {
    it("requires every production Label to name a control or labelled group", () => {
        const failures: string[] = [];
        for (const file of filesUnder(sourceRoot)) {
            if (file.endsWith("components/ui/label.tsx")) continue;
            const source = readFileSync(file, "utf8")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/\/\/.*$/gm, "");
            for (const match of source.matchAll(/<Label\b[\s\S]*?>/g)) {
                if (!/\b(?:htmlFor|id)=/.test(match[0])) {
                    failures.push(
                        `${relative(sourceRoot, file)}: ${match[0].replace(/\s+/g, " ")}`,
                    );
                }

                const htmlFor = match[0].match(/\bhtmlFor="([^"]+)"/);
                if (
                    htmlFor &&
                    !new RegExp(`\\bid="${htmlFor[1]}"`).test(source)
                ) {
                    failures.push(
                        `${relative(sourceRoot, file)}: htmlFor="${htmlFor[1]}" has no matching id`,
                    );
                }

                const labelId = match[0].match(/\bid="([^"]+)"/);
                if (
                    labelId &&
                    !new RegExp(`\\baria-labelledby="${labelId[1]}"`).test(
                        source,
                    )
                ) {
                    failures.push(
                        `${relative(sourceRoot, file)}: label id="${labelId[1]}" is not referenced`,
                    );
                }
            }
        }
        expect(failures).toEqual([]);
    });
});
