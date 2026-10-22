#!/usr/bin/env sh
#
# Single source of truth for the JS dependency audit.
#
# Both the CI "Lint" job (.github/workflows/ci.yml) and the release
# "verify" job (.github/workflows/release.yml) call this script instead of each
# spelling out their own `bun audit` invocation. Previously they diverged — CI
# carried --ignore flags while release ran a plain `bun audit --audit-level=high`
# — so an accepted-risk advisory could pass one workflow and fail the other. Keep
# the audit command (and any accepted-risk ignore list) here, in one place.
#
# Accepted-risk ignores, if ever needed, go on the command below as
# `--ignore=<GHSA-id>` with a one-line justification comment. Prefer bumping the
# dependency past its fix (root package.json overrides/resolutions) over ignoring
# it whenever a patched version exists.
#
# Accepted risk (no patched release exists; recheck when braces > 3.0.3 ships):
#   GHSA-vfj7-8cjw-p6xm  braces <=3.0.3 stack exhaustion on deeply nested
#   patterns. Reached only through kysely-codegen > micromatch, a dev-only tool
#   that is never bundled; its only pattern is the fixed `db:codegen` argument.
#
# Not covered here: SheetJS `xlsx` is installed from its own CDN tarball
# (https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz, pinned by sha512 in
# bun.lock) because SheetJS no longer publishes to npm. Dependabot cannot update
# it and npm advisories do not describe it. Check by hand when touching imports:
# https://cdn.sheetjs.com/xlsx-latest/package/package.json gives the newest
# version (0.20.3 on 2026-10-22) and https://git.sheetjs.com/sheetjs/sheetjs
# lists fixes. scripts/check-workflow-supply-chain.ts allowlists the exact URL.
#
# Runs from the repo root; the workflows check out + install before invoking it.
# The root and Electron package each have a committed Bun lockfile, so both
# dependency graphs must be audited.

set -eu

bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm
(cd packaging/electron && bun audit --audit-level=high)
