# Changelog

All notable changes to Vision are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This changelog was introduced after v1.0.2. Entries below that tag are curated highlights
> grouped from the Conventional Commit history and the Architecture Decision Records
> ([`docs/adr/`](docs/adr/)); the full record lives in git history. Pull request numbers (#nnn)
> refer to https://github.com/EraPartner/Vision/pull/nnn.

## [Unreleased]

## [1.1.0] — 2026-10-28

> [!IMPORTANT]
> **No in-place upgrade from 1.0.x.** Vision 1.0.x ran its database in Docker and migrated it
> with Alembic. Vision 1.1.0 is a native macOS app with its own private PostgreSQL 18 cluster
> ([ADR-113], [ADR-133]) and a Kysely migration baseline ([ADR-222]). It refuses a database that
> still carries Alembic metadata and refuses backups taken before the baseline
> (`BACKUP_PRE_BASELINE`) ([ADR-224]). Install 1.1.0 from the DMG and start with a new database.
> The app is unsigned: macOS asks for confirmation on first launch (see the release README).

### Added

- **macOS-native Electron shell** — traffic lights, native menu bar, dock integration, CSV
  file handoff, vibrancy, and system accent color ([ADR-072]); boot splash and window-state
  persistence; app icon redrawn in an emerald/gold palette.
- **Premium frontend overhaul** — "liquid glass" v2/v3 visual system ([ADR-070], [ADR-071]),
  sparkline scrubbing, dashboard suggestions card, row context menus, Quick Look on Space,
  arrow-key table navigation, and a money-typography sweep.
- **Visual-effects tiers** with per-display auto-adaptation ([ADR-075]).
- **Portfolio** — FX attribution for gains via per-transaction historical rates; live
  net-worth overlay with daily gap-fill for dense price history.
- **Imports** — save, edit, and delete named custom CSV parsers; BNP Paribas Fortis adapter.
- **Belgian tax** — historical year viewer with auto-snapshotted profiles, as-filed
  snapshots, audit log, comparison, and trend strip ([ADR-058], [ADR-059]); PwC-aligned
  personal income tax calculation.
- **Transactions** — bulk delete / update / export with filter-scope select-all;
  freeform **tags** as an orthogonal dimension.
- **Accessibility** — localized chart screen-reader summaries and aria-labels with
  keyboard activation.
- **Native macOS runtime** — the app bundles PostgreSQL 18, the backend and the migration
  runner and keeps its data and attachments in the application data directory; Docker is no
  longer used ([ADR-113], [ADR-133]). The shell is macOS-only and Apple Silicon-only
  ([ADR-219]).
- **Apple Foundation Models** as a second local AI model next to Ollama, through the small
  `vision-apple-ai` helper; available on macOS 26 ([ADR-246], #350).
- **Full effects** setting (`auto`, `on`, `off`; default `auto`) that restores the richer glass
  and aurora effects within each visual tier ([ADR-244], [ADR-255], #348, #369).
- **Backup before boot migrations** — the desktop app takes a `.visionbak` backup into
  `pre-update-backups` before a launch applies pending migrations, and stops the launch if the
  backup fails ([ADR-242], #342).
- **Imports** — Saxo XLSX and IBKR funding workbooks import without double counting; near
  cross-export matches wait for the owner's per-row choice ([ADR-236], [ADR-239], #339, #342,
  #344).

### Changed

- **Database migrations moved to TypeScript** ([ADR-222]). Alembic and its 128 revisions are
  replaced by Kysely's migrator and one squashed baseline, `db/migrations/0001_baseline.sql`;
  migration SQL is linted with squawk (`bun run db:lint`). Python, the PyInstaller migration
  runner, mypy and `pip-audit` are gone from development, CI and the macOS app. **Breaking:**
  backups taken before the switch are refused on restore (`BACKUP_PRE_BASELINE`); take a fresh
  backup after upgrading.
- Upgraded to **React 19** ([ADR-076]).
- Replaced hard-coded color literals with semantic design tokens across the UI.
- Centralized dashboard/statistics exclusion resolution; numerous memoization and query
  refactors.
- **Proportional CI** — CI runs seven jobs instead of about 22; pull requests split the
  frontend tests over two shards without coverage, while pushes to `main` keep the coverage
  ratchet. Dependabot opens one grouped pull request per ecosystem. Release verification
  requires a passing `CI Complete` on the tagged commit instead of re-running the suites
  ([ADR-221]).
- **Figures are computed by the backend** — totals, FX conversion, cost basis and gains come
  from the server; a missing exchange rate is reported instead of being counted 1:1
  ([ADR-216], #301, #308).
- **Report PDFs** are printed by Electron's own Chromium in a hidden, sandboxed window; the
  bundled Chrome Headless Shell and Puppeteer are gone ([ADR-234], #339).
- **Backend is loopback-only** — it refuses a non-loopback bind and accepts only localhost
  hosts and origins ([ADR-233], #339).
- **Belgian portfolio tax** is computed per tax year from that year's sells ([ADR-240], #342).
- **Ollama requests** are sized to the prompt, the model and the Mac's memory, and send only
  the tools a question needs ([ADR-248], #355); follow-up questions pick tools together with
  the previous question (#357).
- **Dependencies** — installs wait 7 days for new releases, run no lifecycle scripts and use
  the frozen lockfile; 18 direct dependencies are replaced by in-repo code ([ADR-245], #349).
- **Strict type-checked TypeScript** in every project, with exhaustive API enums ([ADR-251],
  [ADR-253], #363, #370, #371).

### Removed

- **Cloud AI** — the OpenAI API route, the Codex subscription experiment and AgentCloak.
  Investigations run only on local models. Migration 0002 deletes non-local investigation
  jobs ([ADR-229], #336).
- **Life scenario panel** on the Portfolio Forecast page; migration 0003 deletes its saved
  setting. The forecast endpoint is unchanged ([ADR-230], #337).
- **Audit history** — the tamper-evident audit chain, its Keychain witness and the change-log
  tables; migration 0004 drops them ([ADR-231], #338).
- **Admin token** — the `ADMIN_AUTH_TOKEN` bearer check and its UI, together with the other
  Docker/LAN-era seams ([ADR-233], #339).
- The source-launcher download and update channel; the packaged app is the only install path
  ([ADR-218]).
- The development devcontainer ([ADR-077] is superseded; [ADR-133]).

### Fixed

- **Analysis executor disabled after the first launch** — startup revoked privileges schema-wide,
  which failed on the runtime materialized views the app role owns ("permission denied for table
  mv_category_totals"). It now revokes only the executor's own grants.
- Cleared multiple full-codebase audit backlogs (May–June 2026), including precision,
  timezone, and dedup robustness fixes.
- Electron: unjammed menu/dock/CSV actions and hardened menu accelerators; gated initial
  navigation on warmup readiness; lazy `safeStorage` access to avoid Keychain prompts.
- Planned loans rewritten atomically on PATCH; portfolio daily snapshots converted at
  historical FX rates.
- Made the frontend type-check gate real (fixed ~160 latent type errors).
- Bug sweep after the cleanups: public links open in the macOS browser and attachments
  download in place, import review flags already-imported rows, calendar-day handling for
  dates, and Demo fixes (#342).
- The saved theme paints from the first frame in the packaged app (#343).
- Sheet and dialog controls stay clickable over the title-bar drag region (#345).
- The API inspector icon stops pulsing after requests end (#358, #359).
- The reduced visual tier really turns glass filters off ([ADR-259], #375).

### Performance

- Eliminated N+1 queries and redundant backend work; shared portfolio-summary cache with
  batched FX conversion; memoized chart formatters and page-level derived data.
- Faster transaction list, account balances and all-time summary queries (#328); less work in
  import reconciliation, the forecast Monte Carlo, recipient patterns and FX conversion (#324);
  the dashboard reuses an unchanged month forecast (#325); faster backend boot (#326).
- After launch, background work is bounded and deferred ([ADR-247], #354); the private
  PostgreSQL cluster is sized for one desktop user (#353).
- Mac GPU, CPU and memory work cut across the aurora, glass surfaces, ledger scrolling, chart
  entrances, chat streaming and idle polling ([ADR-255] to [ADR-258], [ADR-260], [ADR-261],
  #329, #369, #372, #373, #374, #376, #378).

### Security

- **SSRF guard** for outbound custom price-provider URLs (write + fetch boundaries).
- **Admin auth** replaced IP-allowlist with token-or-open + a CSRF guard ([ADR-063]). The
  token was later removed with the loopback-only backend ([ADR-233]).
- The `/api` cross-site guard covers every method, including GET, HEAD and OPTIONS
  ([ADR-237], #340).
- Patched vulnerable dependencies and Electron file races (#318).
- CI supply-chain tooling: gitleaks (CI + pre-commit), `bun audit`, `pip-audit`, Trivy
  image scan, CodeQL SAST, and Electron release builds with `--ignore-scripts` ([ADR-050]).
  The Trivy scan was later removed as overlapping Dependency Review, `bun audit` and
  `pip-audit` ([ADR-221]).
- Bumped transitive `tmp` 0.2.5 → 0.2.7 (GHSA-ph9p-34f9-6g65).

## [1.0.2] — 2026-05-04

Patch release on top of 1.0.1.

## [1.0.1] — 2026-05-04

Stabilization release: bug-hunt fixes, migration corrections, CI hardening (pinned action
SHAs, quality gate, coverage, pip-audit), and the initial supply-chain security scans.

## [1.0.0] — 2026-04-28

First tagged release of Vision: self-hosted financial transaction manager with transaction
CRUD and categorization, multi-adapter bank CSV import, portfolio tracking, Belgian tax,
planned/recurring transactions, en/nl i18n, and an Electron desktop build.

[Unreleased]: https://github.com/EraPartner/Vision/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/EraPartner/Vision/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/EraPartner/Vision/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/EraPartner/Vision/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EraPartner/Vision/releases/tag/v1.0.0
[ADR-050]: docs/adr/050-ci-supply-chain-security-tooling.md
[ADR-058]: docs/adr/058-belgian-tax-historical-year-snapshots.md
[ADR-059]: docs/adr/059-belgian-tax-historical-year-extensions.md
[ADR-063]: docs/adr/063-admin-auth-csrf-guard.md
[ADR-070]: docs/adr/070-liquid-glass-v2-premium-frontend.md
[ADR-071]: docs/adr/071-premium-v3-effects-toggle.md
[ADR-072]: docs/adr/072-electron-native-desktop-integration.md
[ADR-075]: docs/adr/075-visual-effects-tiers-display-adaptation.md
[ADR-076]: docs/adr/076-react-19-upgrade.md
[ADR-077]: docs/adr/077-devcontainer-apple-container-runtime.md
[ADR-113]: docs/adr/113-native-macos-runtime.md
[ADR-133]: docs/adr/133-native-only-runtime-and-delivery.md
[ADR-216]: docs/adr/216-server-owned-domain-calculations.md
[ADR-218]: docs/adr/218-retire-source-launcher-update-channel.md
[ADR-219]: docs/adr/219-minimal-electron-shell-hardening.md
[ADR-221]: docs/adr/221-proportional-ci.md
[ADR-222]: docs/adr/222-typescript-migrations-kysely-baseline.md
[ADR-224]: docs/adr/224-remove-alembic-adoption.md
[ADR-229]: docs/adr/229-remove-cloud-ai-codex-and-agentcloak.md
[ADR-230]: docs/adr/230-remove-life-scenario.md
[ADR-231]: docs/adr/231-remove-audit-history.md
[ADR-233]: docs/adr/233-loopback-only-backend.md
[ADR-234]: docs/adr/234-electron-report-pdf-printing.md
[ADR-236]: docs/adr/236-simplify-portfolio-import-reconciliation.md
[ADR-237]: docs/adr/237-cross-site-guard-for-every-method.md
[ADR-239]: docs/adr/239-import-review-owner-choices.md
[ADR-240]: docs/adr/240-portfolio-tax-per-tax-year.md
[ADR-242]: docs/adr/242-backup-before-boot-migrations.md
[ADR-244]: docs/adr/244-full-effects-switch.md
[ADR-245]: docs/adr/245-dependency-supply-chain.md
[ADR-246]: docs/adr/246-apple-foundation-models-helper.md
[ADR-247]: docs/adr/247-launch-background-work-bounds.md
[ADR-248]: docs/adr/248-ollama-request-tuning.md
[ADR-251]: docs/adr/251-exhaustive-api-enums-in-typescript.md
[ADR-253]: docs/adr/253-strict-type-checked-typescript.md
[ADR-255]: docs/adr/255-cheaper-full-effects.md
[ADR-256]: docs/adr/256-electron-memory-and-idle-work.md
[ADR-257]: docs/adr/257-ledger-scroll-and-squircle-clips.md
[ADR-258]: docs/adr/258-chart-entrances-and-compositor-diagnostics.md
[ADR-259]: docs/adr/259-reduced-tier-backdrop-filter-order.md
[ADR-260]: docs/adr/260-ledger-card-material-on-a-pseudo.md
[ADR-261]: docs/adr/261-ticker-and-settings-material-hosts-and-20-fps-aurora.md
