import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// ── custom local rule ─────────────────────────────────────────────────────────

/**
 * no-feature-import-from-component
 *
 * One layering rule for the `features/` ↔ `components/` boundary:
 * `src/features/**` may import `src/components/**` (a feature composes shared
 * UI), never the reverse. `src/components/**` is what is left after the
 * feature migration — genuinely shared surface (`ui`, `shared`, `charts`,
 * `layout`, `notifications`, `devtools`, `auth`) — and a shared component that
 * reaches into a feature inverts the dependency, dragging feature state and
 * feature-sized bundles into the shared layer.
 *
 * A closed allowlist carries the sanctioned exceptions, keyed by the file's
 * path under `src/` and pinning the exact modules it may reach. It is the
 * machine-readable twin of the callout in
 * docs/architecture/frontend-architecture.md. Do not add entries: the rule is
 * that a shared component takes what it needs as props, or the component
 * belongs in the feature.
 */
const SANCTIONED_COMPONENT_FEATURE_IMPORTS = {
  // AppLayout is the app shell — the composition root that mounts the
  // settings dialog and the onboarding wizard over every page. It is
  // `components/`-shaped only because there is no `app/` directory.
  "components/layout/AppLayout.tsx": [
    "@/features/settings/DashboardSettingsDialog",
    "@/features/onboarding/OnboardingWizard",
    "@/features/onboarding/useOnboarding",
  ],
  // A test of the SHARED loading-surface contract that uses one real feature
  // tab as its worked example. Test-only: never bundled into the app.
  "components/shared/__tests__/loadingSurface.test.tsx": [
    "@/features/research/ResearchAnalystTab",
  ],
};

const isFeatureModule = (src) =>
  typeof src === "string" &&
  (src.startsWith("@/features/") || /(^|\/)features\//.test(src));

const noFeatureImportFromComponent = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Shared components must not import feature modules; the features/ → components/ edge is one-way.",
      url: null,
    },
    messages: {
      noFeature:
        "Shared component imports '{{source}}' from features/, inverting the " +
        "features/ → components/ layering. Move this component into the feature, or take " +
        "what it needs as a prop.",
      notSanctionedModule:
        "'{{file}}' has a sanctioned feature exception for {{allowed}} only, but imports " +
        "'{{source}}'. The exception does not extend to other feature modules — update " +
        "docs/architecture/frontend-architecture.md and eslint.config.js together, or move " +
        "the component into the feature.",
    },
    schema: [],
  },
  create(context) {
    const file = (context.filename ?? context.getFilename()).replace(
      /\\/g,
      "/",
    );
    const key = file.slice(file.indexOf("/src/") + "/src/".length);
    const allowed = SANCTIONED_COMPONENT_FEATURE_IMPORTS[key];
    // `export … from '@/features/…'` re-exports reach the feature layer exactly
    // like an import does, and a lazy `import()` reaches it at runtime, so all
    // node kinds go through the same check.
    const check = (node) => {
      const src = node.source?.value;
      if (!isFeatureModule(src)) return;
      if (!allowed) {
        context.report({ node, messageId: "noFeature", data: { source: src } });
        return;
      }
      if (!allowed.includes(src)) {
        context.report({
          node,
          messageId: "notSanctionedModule",
          data: { file: key, source: src, allowed: allowed.join(", ") },
        });
      }
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: (node) => check({ ...node, source: node.source }),
    };
  },
};

/**
 * no-hardcoded-user-facing-string
 *
 * Surface untranslated JSX copy while the existing locale validator continues
 * to enforce catalogue parity. This rule is warning-only because legacy
 * literals remain. It checks rendered JSX text and the string-valued
 * attributes that browsers or assistive technology expose to users.
 */
const USER_FACING_STRING_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "placeholder",
  "title",
]);

const containsWords = (value) => /\p{L}{2,}/u.test(value);

const staticExpressionText = (expression) => {
  if (expression?.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (
    expression?.type === "TemplateLiteral" &&
    expression.expressions.length === 0
  ) {
    return (
      expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw
    );
  }
  return undefined;
};

const noHardcodedUserFacingString = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when rendered JSX copy bypasses the translation catalogue.",
      url: null,
    },
    messages: {
      literal:
        "Hardcoded user-facing text '{{text}}' bypasses i18n. Use a translation key or document why this literal is not user-facing.",
    },
    schema: [],
  },
  create(context) {
    const report = (node, value) => {
      const text = value.replace(/\s+/g, " ").trim();
      if (!text || !containsWords(text)) return;
      context.report({ node, messageId: "literal", data: { text } });
    };

    return {
      JSXText: (node) => report(node, node.value),
      JSXAttribute: (node) => {
        const attribute = node.name?.name;
        if (
          typeof attribute !== "string" ||
          !USER_FACING_STRING_ATTRIBUTES.has(attribute) ||
          node.value?.type !== "Literal" ||
          typeof node.value.value !== "string"
        ) {
          return;
        }
        report(node.value, node.value.value);
      },
      JSXExpressionContainer: (node) => {
        const text = staticExpressionText(node.expression);
        if (text === undefined) return;

        if (node.parent?.type === "JSXAttribute") {
          const attribute = node.parent.name?.name;
          if (
            typeof attribute !== "string" ||
            !USER_FACING_STRING_ATTRIBUTES.has(attribute)
          ) {
            return;
          }
        } else if (
          node.parent?.type !== "JSXElement" &&
          node.parent?.type !== "JSXFragment"
        ) {
          return;
        }

        report(node.expression, text);
      },
    };
  },
};

export default tseslint.config(
  // coverage/ is an istanbul build artifact — linting it produced six
  // "unused eslint-disable" warnings from generated files.
  { ignores: ["../../dist", "coverage"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // React Hooks v4 rules (kept as-is)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // New v7 rules — disabled until code is migrated to comply
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/immutability": "off",
      "react-hooks/globals": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/config": "off",
      "react-hooks/gating": "off",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Warn on unused vars/imports; prefix with _ to intentionally suppress (e.g. _unused)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test harness helpers legitimately export non-component utilities next
    // to wrapper components; fast refresh never applies under vitest.
    files: ["src/test/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // components/ → features/ enforcement — shared components only.
    files: ["src/components/**/*.{ts,tsx}"],
    plugins: {
      "vision-local": {
        rules: {
          "no-feature-import-from-component": noFeatureImportFromComponent,
        },
      },
    },
    rules: {
      "vision-local/no-feature-import-from-component": "error",
    },
  },
  {
    // Surface untranslated production copy without making the legacy
    // warning backlog a release blocker or linting test-fixture text.
    files: ["src/{components,pages}/**/*.tsx"],
    ignores: ["src/**/__tests__/**", "src/**/*.test.tsx"],
    plugins: {
      "vision-i18n": {
        rules: {
          "no-hardcoded-user-facing-string": noHardcodedUserFacingString,
        },
      },
    },
    rules: {
      "vision-i18n/no-hardcoded-user-facing-string": "warn",
    },
  },
);
