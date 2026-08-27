---
name: i18n
description: Add or change Vision user-facing strings and English or Dutch locale content. Use for translation keys, locale files, Dutch translation, generated locales, or any change under i18n/.
---

# Vision localization

Read `docs/i18n/index.md` and `docs/i18n/translations.md` before non-trivial work. Edit source files
under `i18n/source/`; generated files live under `apps/frontend/src/locales/`.

```bash
bun run generate-locales
bun run sanitize-locales
bun run sync-nl
bun run validate-locales
```

For a new user-facing string, add the source key, regenerate locales, synchronize Dutch keys, and
finish with `bun run validate-locales`. Treat validation failure as a broken build. Do not edit a
generated locale without updating its source.

Use the product terminology and capitalization rules in `docs/glossary.md` and
`docs/i18n/translations.md`. English buttons, dialog titles, and action labels use sentence case.
