// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
    return readdirSync(root).flatMap((name) => {
        const path = join(root, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.(ts|tsx)$/.test(name))
            return [];
        return [path];
    });
}

describe("background query cue adoption", () => {
    it("registers every production placeholderData observer with the global cue", () => {
        const srcRoot = join(process.cwd(), "src");
        const violations = sourceFiles(srcRoot).flatMap((path) => {
            const source = readFileSync(path, "utf8");
            const sourceFile = ts.createSourceFile(
                path,
                source,
                ts.ScriptTarget.Latest,
                true,
                path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            let placeholderObservers = 0;
            let cueRegistrations = 0;

            function visit(node: ts.Node) {
                if (
                    ts.isPropertyAssignment(node) &&
                    node.name.getText(sourceFile) === "placeholderData"
                ) {
                    placeholderObservers += 1;
                }
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "useBackgroundQueryCue"
                ) {
                    cueRegistrations += 1;
                }
                ts.forEachChild(node, visit);
            }

            visit(sourceFile);
            return cueRegistrations >= placeholderObservers
                ? []
                : [
                      `${relative(process.cwd(), path)}: placeholderData=${placeholderObservers}, cues=${cueRegistrations}`,
                  ];
        });

        expect(violations).toEqual([]);
    });
});
