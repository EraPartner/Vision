---
name: i18n
description: Vision's i18n/locale workflow (en/nl) — adding or changing user-facing strings, translating, syncing Dutch, validating locales. Use when a change touches UI text, translation keys, locale files, or the user mentions translations/Dutch/i18n.
---

# i18n workflow

Source of truth: `i18n/source/` → generated into `apps/frontend/src/locales/`. Read
`docs/i18n/index.md` and `docs/i18n/translations.md` before non-trivial locale work.

```bash
bun run generate-locales     # i18n/source/ -> apps/frontend/src/locales/ (build runs this too)
bun run sanitize-locales     # normalize/clean source files
bun run sync-nl              # sync Dutch keys with English (scripts/sync-nl-with-en.js)
bun run validate-locales     # REQUIRED after any i18n change (CLAUDE.md mandate)
```

Helper scripts live in `scripts/` (`auto-translate-nl.js`, `auto-translate-nl-pass2.js`,
`locales-capitalizer.js`). New user-facing strings: add the key to `i18n/source/`, regenerate,
then `sync-nl` so the Dutch side doesn't drift, and finish with `validate-locales` — treat a
validation failure as a broken build.
