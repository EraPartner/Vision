import path from "node:path";
import ts from "typescript";

export interface TranslationCall {
  fn: "t" | "tc";
  key: string;
  line: number;
  /** Static interpolation variable names, or null when absent or dynamic. */
  variableNames: string[] | null;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  return path.extname(fileName).toLowerCase() === ".tsx"
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function staticPropertyName(
  name: ts.PropertyName | undefined,
): string | undefined {
  if (name === undefined || ts.isComputedPropertyName(name)) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

export function objectLiteralKeys(
  expression: ts.Expression | undefined,
): string[] | null {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return null;

  const keys: string[] = [];
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    const name = staticPropertyName(property.name);
    if (name === undefined) return null;
    keys.push(name);
  }
  return keys;
}

export function extractTranslationCalls(
  code: string,
  fileName: string,
): TranslationCall[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const calls: TranslationCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      if (fn === "t" || fn === "tc") {
        const keyNode = node.arguments[0];
        if (
          keyNode &&
          (ts.isStringLiteral(keyNode) ||
            ts.isNoSubstitutionTemplateLiteral(keyNode))
        ) {
          const varsIndex = fn === "t" ? 1 : 2;
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          calls.push({
            fn,
            key: keyNode.text,
            line: line + 1,
            variableNames: objectLiteralKeys(node.arguments[varsIndex]),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}
