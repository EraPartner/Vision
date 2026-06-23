# Changelog

All notable changes to Vision are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This changelog was introduced after v1.0.2. Entries below that tag are curated highlights
> grouped from the Conventional Commit history and the Architecture Decision Records
> ([`docs/adr/`](docs/adr/)); the full record lives in git history. The working tree is
> substantially ahead of the last tagged release — see **[Unreleased]**.

## [Unreleased]

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
- **Hardened devcontainer** — SNI egress proxy, fail-closed firewall, allowlist, and a
  migration to `apple/container` ([ADR-077]).

### Changed

- Upgraded to **React 19** ([ADR-076]).
- Replaced hard-coded color literals with semantic design tokens across the UI.
- Centralized dashboard/statistics exclusion resolution; numerous memoization and query
  refactors.

### Fixed

- Cleared multiple full-codebase audit backlogs (May–June 2026), including precision,
  timezone, and dedup robustness fixes.
- Electron: unjammed menu/dock/CSV actions and hardened menu accelerators; gated initial
  navigation on warmup readiness; lazy `safeStorage` access to avoid Keychain prompts.
- Planned loans rewritten atomically on PATCH; portfolio daily snapshots converted at
  historical FX rates.
- Made the frontend type-check gate real (fixed ~160 latent type errors).

### Performance

- Eliminated N+1 queries and redundant backend work; shared portfolio-summary cache with
  batched FX conversion; memoized chart formatters and page-level derived data.

### Security

- **SSRF guard** for outbound custom price-provider URLs (write + fetch boundaries).
- **Admin auth** replaced IP-allowlist with token-or-open + a CSRF guard ([ADR-063]).
- CI supply-chain tooling: gitleaks (CI + pre-commit), `bun audit`, `pip-audit`, Trivy
  image scan, CodeQL SAST, and Electron release builds with `--ignore-scripts` ([ADR-050]).
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

[Unreleased]: https://github.com/EraPartner/Vision/compare/v1.0.2...HEAD
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
