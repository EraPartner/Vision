i18n — Translation Workflow

This repository uses a single-source-of-truth approach for translations.

- Masters: edit files in `i18n/source/*.json` only. These JSON files are the canonical translation source.
- Generation: run the generator to produce frontend and packaging artifacts:
  - `npm run generate-locales` (or `node scripts/generate-locales.js`)
- Sanitize: if your translations include curly quotes or other typographic characters, run:
  - `npm run sanitize-locales` (normalizes smart quotes and similar characters)
- Validate parity and drift:
  - `npm run validate-locales`
  - Checks include: missing/extra keys vs `en`, non-string values, placeholder-token parity, suspicious escaped-tail corruption patterns, and generated-output drift against source.

Do not edit generated files under `apps/frontend/src/locales` or `packaging/electron/i18n` — they are overwritten by the generator.

The generator is strict: it never reads generated files as input. If generated files drift or are malformed, fix `i18n/source/*.json` and regenerate.

Recommended workflow for translators or developers:
1. Edit `i18n/source/nl.json` (or `en.json`) directly.
2. Run `npm run sanitize-locales` (optional but helpful when pasting from external editors).
3. Run `npm run generate-locales` to propagate changes to the app.
4. Run `npm run validate-locales` to confirm parity.

Container/electron notes:
- Docker build runs locale generation so images are always aligned with `i18n/source`.
- Electron startup uses the generated `packaging/electron/i18n/*.json`; keep these committed and in sync via the generator.

If you need automated translation help for missing Dutch keys, coordinate with the maintainers — the repository intentionally falls back to English for missing keys.
