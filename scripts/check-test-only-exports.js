#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const repositoryRoot = path.resolve(__dirname, "..");
const backendRootArgument = process.argv.indexOf("--backend-root");
const usesCustomBackendRoot = backendRootArgument >= 0;
const backendRoot = usesCustomBackendRoot
  ? path.resolve(process.argv[backendRootArgument + 1])
  : path.join(repositoryRoot, "apps/node-backend");
const sourceRoot = path.join(backendRoot, "src");
const testRoot = path.join(backendRoot, "tests");

// Stable module APIs can be exercised directly by tests even when today's
// production graph reaches them through a facade, a default object, or an
// external entry point. They are not test-support seams and keep public names.
const PUBLIC_NAMED_EXPORTS = new Set([
  // Public facades, domain helpers, and contract types.
  "apps/node-backend/src/integrations/ollama/prompts.js:toOllamaMessage",
  "apps/node-backend/src/lib/importBatchIds.js:coercedIdSchema",
  // Named helpers mirrored by a stable runtime default object.
  "apps/node-backend/src/lib/calculations/splits.js:roundToCents",
  "apps/node-backend/src/lib/calculations/splits.js:validatePaymentAmount",
  "apps/node-backend/src/lib/urlSafety.js:BlockedUrlError",
  "apps/node-backend/src/repositories/infoRepository.js:clearMvCache",
  // Named methods mirrored by stable runtime repository default objects.
  "apps/node-backend/src/repositories/cashflowForecastMcRepository.js:get",
  "apps/node-backend/src/repositories/cashflowForecastMcRepository.js:isFresh",
  "apps/node-backend/src/repositories/cashflowForecastMcRepository.js:upsert",
  "apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js:get",
  "apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js:isFresh",
  "apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js:upsert",
  "apps/node-backend/src/services/accountService.js:accountService",
  "apps/node-backend/src/services/bankAdapters.js:createAdapter",
  "apps/node-backend/src/services/bankAdapters.js:detectBank",
  "apps/node-backend/src/services/bankAdapters.js:getSupportedBanks",
  "apps/node-backend/src/services/calculations/portfolioMath.js:annualizedReturn",
  "apps/node-backend/src/services/calculations/portfolioMath.js:calculateAccruedInterest",
  "apps/node-backend/src/services/calculations/portfolioMath.js:sanitizeIsolatedValueSpikes",
  "apps/node-backend/src/services/deduplication.js:isDuplicate",
  "apps/node-backend/src/services/importPipeline/index.js:createBatch",
  "apps/node-backend/src/services/importPipeline/index.js:prepareImport",
  // Named methods mirrored by stable runtime adapter default objects.
  "apps/node-backend/src/services/importPipeline/adapters/bnp.js:parse",
  "apps/node-backend/src/services/importPipeline/adapters/generic.js:parse",
  "apps/node-backend/src/services/importPipeline/adapters/ing.js:parse",
  "apps/node-backend/src/services/importPipeline/adapters/vision.js:detect",
  "apps/node-backend/src/services/importPipeline/adapters/wise.js:parse",
  "apps/node-backend/src/services/portfolioImportPipeline/index.js:prepareImport",
  "apps/node-backend/src/services/priceProviderService.js:getHistoricalPriceAt",
  "apps/node-backend/src/services/prices/priceCache.js:dateOnlyToTimestampMs",
  "apps/node-backend/src/services/quoteBackfillService.js:cleanupStaleQuotes",
  "apps/node-backend/src/services/research/adapters/macroCatalog.js:MACRO_CATALOG",
  "apps/node-backend/src/services/research/capabilityMap.js:PROVIDERS",
  "apps/node-backend/src/services/splitService.js:addPayment",
  "apps/node-backend/src/services/splitService.js:createSplitAtomic",
  "apps/node-backend/src/services/splitService.js:deleteSplit",
  "apps/node-backend/src/services/splitService.js:settleSplit",
]);

function walkJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJavaScriptFiles(entryPath);
    return entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

const sourceFiles = walkJavaScriptFiles(sourceRoot);
const testFiles = walkJavaScriptFiles(testRoot);
const knownFiles = new Set([...sourceFiles, ...testFiles]);

function resolveRelativeModule(importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const basePath = path.resolve(path.dirname(importer), specifier);
  return [basePath, `${basePath}.js`, path.join(basePath, "index.js")].find(
    (candidate) => knownFiles.has(candidate),
  );
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function hasExportModifier(node) {
  return (
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function exportedSurface(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (hasExportModifier(statement)) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(declaration.name)) names.add(name);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements)
        names.add(element.name.text);
    }
  }
  return names;
}

const exportsByFile = new Map(
  sourceFiles.map((file) => [
    file,
    exportedSurface(
      ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
    ),
  ]),
);
const consumers = new Map();

function recordConsumer(target, exportedName, consumer, kind) {
  if (!target || !exportedName || exportedName === "default") return;
  const key = `${target}\0${exportedName}`;
  const entries = consumers.get(key) ?? [];
  entries.push({ consumer, kind });
  consumers.set(key, entries);
}

function scanConsumers(file, kind) {
  const sourceFile = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const namespaceImports = new Map();
  const dynamicModules = new Map();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveRelativeModule(
        file,
        statement.moduleSpecifier.text,
      );
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          recordConsumer(
            target,
            element.propertyName?.text ?? element.name.text,
            file,
            kind,
          );
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceImports.set(bindings.name.text, target);
        if (kind === "production") {
          for (const name of exportsByFile.get(target) ?? []) {
            recordConsumer(target, name, file, kind);
          }
        }
      }
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveRelativeModule(
        file,
        statement.moduleSpecifier.text,
      );
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          recordConsumer(
            target,
            element.propertyName?.text ?? element.name.text,
            file,
            kind,
          );
        }
      }
    }
  }

  function importedTarget(expression) {
    if (!ts.isAwaitExpression(expression)) return undefined;
    const call = expression.expression;
    if (
      !ts.isCallExpression(call) ||
      call.expression.kind !== ts.SyntaxKind.ImportKeyword
    )
      return undefined;
    const [argument] = call.arguments;
    return argument && ts.isStringLiteral(argument)
      ? resolveRelativeModule(file, argument.text)
      : undefined;
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const target = importedTarget(node.initializer);
      if (target && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          recordConsumer(
            target,
            element.propertyName?.getText(sourceFile) ??
              element.name.getText(sourceFile),
            file,
            kind,
          );
        }
      } else if (target && ts.isIdentifier(node.name)) {
        dynamicModules.set(node.name.text, target);
        if (kind === "production") {
          for (const name of exportsByFile.get(target) ?? []) {
            recordConsumer(target, name, file, kind);
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const target =
          namespaceImports.get(node.expression.text) ??
          dynamicModules.get(node.expression.text);
        recordConsumer(target, node.name.text, file, kind);
      } else {
        const target = importedTarget(node.expression);
        recordConsumer(target, node.name.text, file, kind);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

for (const file of sourceFiles) scanConsumers(file, "production");
for (const file of testFiles) scanConsumers(file, "test");

const violations = [];
const stalePublicExports = usesCustomBackendRoot
  ? []
  : [...PUBLIC_NAMED_EXPORTS].filter((entry) => {
      const separator = entry.lastIndexOf(":");
      const file = path.join(repositoryRoot, entry.slice(0, separator));
      const name = entry.slice(separator + 1);
      return !exportsByFile.get(file)?.has(name);
    });

for (const [file, names] of exportsByFile) {
  for (const name of names) {
    const relativeFile = path.relative(repositoryRoot, file);
    if (
      name.startsWith("__") ||
      PUBLIC_NAMED_EXPORTS.has(`${relativeFile}:${name}`)
    )
      continue;
    const entries = consumers.get(`${file}\0${name}`) ?? [];
    const productionConsumers = entries.filter(
      ({ kind }) => kind === "production",
    );
    const testConsumers = entries.filter(({ kind }) => kind === "test");
    if (productionConsumers.length === 0 && testConsumers.length > 0) {
      violations.push({
        file: relativeFile,
        name,
        suggestedName: `__${name.replace(/^_+/, "")}`,
        tests: [
          ...new Set(
            testConsumers.map(({ consumer }) =>
              path.relative(repositoryRoot, consumer),
            ),
          ),
        ].sort(),
      });
    }
  }
}

violations.sort(
  (left, right) =>
    left.file.localeCompare(right.file) || left.name.localeCompare(right.name),
);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ stalePublicExports, violations }, null, 2));
  process.exit(0);
}

if (stalePublicExports.length > 0) {
  console.error("Stale public named-export allowlist entries:");
  for (const entry of stalePublicExports) console.error(`- ${entry}`);
  process.exitCode = 1;
} else if (violations.length > 0) {
  console.error(
    `Found ${violations.length} unmarked backend test-only named exports:`,
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.file}: ${violation.name} -> ${violation.suggestedName}`,
    );
    for (const test of violation.tests) console.error(`    ${test}`);
  }
  process.exitCode = 1;
} else {
  console.log("Backend test-only named exports use the __ prefix.");
}
