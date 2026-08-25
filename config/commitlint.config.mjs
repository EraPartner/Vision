// Conventional Commits enforcement for the commit-msg hook (.githooks/commit-msg).
// Matches the style already in git history and .github/CONTRIBUTING.md: type(scope): subject —
// e.g. feat/fix/chore/docs/refactor. Allowed types/rules come from
// @commitlint/config-conventional; override here if the project needs to diverge.
// Harmonised with Watchman's commitlint config.
export default {
  extends: ["@commitlint/config-conventional"],
  // CI must never treat a synthetic merge-style fallback message as an
  // automatic pass. The repository requires conventional messages for every
  // commit, so the local hook and CI share the same fail-closed policy.
  defaultIgnores: false,
};
