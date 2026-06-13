// Conventional Commits enforcement for the commit-msg hook (.githooks/commit-msg).
// Matches the style already in git history and CONTRIBUTING.md: type(scope): subject —
// e.g. feat/fix/chore/docs/refactor. Allowed types/rules come from
// @commitlint/config-conventional; override here if the project needs to diverge.
// Harmonised with Watchman's commitlint config.
export default {
  extends: ["@commitlint/config-conventional"],
};
