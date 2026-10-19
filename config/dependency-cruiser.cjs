/**
 * Import boundaries across the workspaces (`bun run lint:deps`).
 *
 * The graph is the runtime graph: type-only imports are elided
 * (tsPreCompilationDeps: false), so a rule here is about code that loads, not
 * about shared type declarations. In-workspace layering (routes → services →
 * repositories, features → components) stays in each workspace's
 * eslint.config.js, which pins exact bindings.
 */

const TEST_FILE =
  "(^|/)(__tests__|tests?|__mocks__)/|\\.(test|spec)\\.[cm]?[jt]sx?$|^apps/frontend/src/test-setup\\.ts$";
// Build and test configuration: never shipped, may load test helpers.
const TOOL_CONFIG = "^apps/frontend/vite\\.config\\.ts$";

// ADR-217: the browser keeps only shape helpers. These modules compute tax
// figures or load the year tables and must stay out of the web bundle.
const BELGIAN_TAX_ENGINE =
  "^packages/shared-utils/src/belgianTax/(assessment|constants|costBreakdown|exemptions|household|householdOwnHome|maritalQuotient|overview|personPit|pit|portfolioDashboard|portfolioTax|propertyTax|socialSecurity)\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Runtime import cycles make module initialisation order-dependent. Break the cycle by moving the shared piece into its own module.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment:
        "The import does not resolve. Fix the path or add the package to the workspace's package.json.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-package",
      severity: "error",
      comment:
        "The module imports an npm package that no package.json on its path declares; it only works through hoisting.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "frontend-not-to-other-apps",
      severity: "error",
      comment:
        "The web app talks to the backend over HTTP only. Shared code belongs in packages/.",
      from: { path: "^apps/frontend/", pathNot: TEST_FILE },
      to: { path: "^(apps/node-backend|packaging)/" },
    },
    {
      name: "backend-not-to-other-apps",
      severity: "error",
      comment:
        "The backend must not load web-app or desktop-shell modules. Shared code belongs in packages/.",
      from: { path: "^apps/node-backend/", pathNot: TEST_FILE },
      to: { path: "^(apps/frontend|packaging)/" },
    },
    {
      name: "electron-not-to-apps",
      severity: "error",
      comment:
        "The desktop shell starts the backend as a process and loads the built frontend; it must not import their sources.",
      from: { path: "^packaging/electron/", pathNot: TEST_FILE },
      to: { path: "^apps/" },
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      comment:
        "Shared packages are leaves of the app graph; importing an app inverts the dependency.",
      from: { path: "^packages/", pathNot: TEST_FILE },
      to: { path: "^(apps|packaging)/" },
    },
    {
      name: "types-package-is-a-leaf",
      severity: "error",
      comment: "@vision/types holds contracts only and imports no workspace code.",
      from: { path: "^packages/types/" },
      to: { path: "^packages/shared-utils/" },
    },
    {
      name: "frontend-no-belgian-tax-engine",
      severity: "error",
      comment:
        "ADR-217: Belgian tax figures come from the server. Use the API hooks instead of the engine.",
      from: { path: "^apps/frontend/src/", pathNot: TEST_FILE },
      to: { path: BELGIAN_TAX_ENGINE, reachable: true },
    },
    {
      name: "production-not-to-tests",
      severity: "error",
      comment:
        "Production code must not import tests, test helpers or mocks; they are not shipped.",
      from: {
        path: "^(apps|packages|packaging)/",
        pathNot: `${TEST_FILE}|${TOOL_CONFIG}|^apps/frontend/src/test/`,
      },
      to: { path: `${TEST_FILE}|^apps/frontend/src/test/` },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)(node_modules|out|out-[^/]+|dist|dist-demo|coverage|native-runtime)/",
    },
    tsPreCompilationDeps: false,
    tsConfig: { fileName: "config/tsconfig.depcruise.json" },
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
    skipAnalysisNotInRules: true,
  },
};
