const path = require('path');
const ts = require('typescript');

function scriptKindFor(fileName) {
  return path.extname(fileName).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function staticPropertyName(name) {
  if (ts.isComputedPropertyName(name)) return undefined;
  if (
    ts.isIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)
    || ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function objectLiteralKeys(expression) {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return null;

  const keys = [];
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    const name = staticPropertyName(property.name);
    if (name === undefined) return null;
    keys.push(name);
  }
  return keys;
}

function extractTranslationCalls(code, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const calls = [];

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      if (fn === 't' || fn === 'tc') {
        const keyNode = node.arguments[0];
        if (keyNode && (ts.isStringLiteral(keyNode) || ts.isNoSubstitutionTemplateLiteral(keyNode))) {
          const varsIndex = fn === 't' ? 1 : 2;
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
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

module.exports = {
  extractTranslationCalls,
  objectLiteralKeys,
};
