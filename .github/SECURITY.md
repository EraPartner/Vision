# Security Policy

Vision is a self-hosted personal-finance application that handles sensitive financial data.
Security reports are taken seriously and handled with care.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

Only the latest 1.0.x line receives security fixes. Run a current build of your
self-hosted instance.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull
requests, or discussions.**

Instead, use **GitHub's private vulnerability reporting**:

1. Go to the [Security tab](https://github.com/EraPartner/Vision/security) of the repository.
2. Click **"Report a vulnerability"** to open a private advisory.

Include as much of the following as you can:

- Affected component (backend route, importer/bank adapter, Electron shell, price provider, etc.)
- A description of the issue and its impact
- Steps to reproduce, a proof-of-concept, or affected source location
- Any suggested remediation

This is a best-effort, single-maintainer project. The goal is to **acknowledge a report
within about a week** and to coordinate a fix and disclosure timeline with you from there.
Please give a reasonable window to remediate before any public disclosure.

## Scope

In scope — issues that could compromise a self-hosted instance or its data, for example:

- Authentication / authorization bypass (e.g. admin auth, CSRF — see
  [ADR-063](docs/adr/063-admin-auth-csrf-guard.md))
- SSRF via outbound price-provider URLs (see [`docs/security/input-validation.md`](docs/security/input-validation.md))
- Injection (SQL, command, path traversal), unsafe deserialization
- Secrets exposure, sensitive-data leakage, or PII handling flaws
- CSV-import parsing flaws that lead to code execution or data corruption
- Electron desktop-shell escapes or unsafe IPC / permission handling

Generally out of scope: vulnerabilities requiring a compromised host or OS account,
self-inflicted misconfiguration of a self-hosted deployment, or findings in dependencies
already tracked by Dependabot / `bun audit` / Trivy / CodeQL unless you can demonstrate
exploitability in Vision.

## How Vision defends itself

The codebase ships defense-in-depth that is documented and worth reading before reporting:

- **Supply chain:** gitleaks (CI + pre-commit), `bun audit`, `pip-audit`, Trivy image scan,
  CodeQL SAST, Electron release builds with `--ignore-scripts`
  ([ADR-050](docs/adr/050-ci-supply-chain-security-tooling.md)).
- **Runtime:** input validation (Zod + server-side), rate limiting, SSRF guard, strict CSP,
  admin token-or-open auth + CSRF guard ([ADR-063](docs/adr/063-admin-auth-csrf-guard.md)).
- **Containers:** non-root user, dropped capabilities, read-only filesystem, resource limits.

Full details: [`docs/security/index.md`](docs/security/index.md).
