#!/usr/bin/env sh
#
# Single source of truth for the JS dependency audit.
#
# Both the CI "Deps Audit (JS)" job (.github/workflows/ci.yml) and the release
# "verify" job (.github/workflows/release.yml) call this script instead of each
# spelling out their own `bun audit` invocation. Previously they diverged — CI
# carried --ignore flags while release ran a plain `bun audit --audit-level=high`
# — so an accepted-risk advisory could pass one workflow and fail the other. Keep
# the audit command (and any accepted-risk ignore list) here, in one place.
#
# Accepted-risk ignores, if ever needed, go on the command below as
# `--ignore=<GHSA-id>` with a one-line justification comment. Prefer bumping the
# dependency past its fix (root package.json overrides/resolutions) over ignoring
# it whenever a patched version exists. There are currently no accepted-risk
# ignores: all known HIGH advisories are resolved past their fix in-tree.
#
# Runs from the repo root; the workflows check out + install before invoking it.

set -eu

# GHSA-qwww-vcr4-c8h2 (react-router RSC-mode CSRF): the vulnerable code path is
# React Server Components mode, which this app cannot reach — Vision is a Vite
# SPA (<BrowserRouter>/<Routes> only; no SSR, no RSC, no server actions). The
# only patched release is react-router 8.3.0, a major migration; tracked in
# TODO.md ("react-router 7→8 migration"). Remove this ignore with that bump.
#
# GHSA-mh99-v99m-4gvg (brace-expansion DoS via unbounded expansion): the only
# patched release is 5.0.8, and its CommonJS export shape changed from a bare
# function to a named `{ expand }` object — forcing it via the root override
# crashes every 1.x/2.x-range consumer at runtime (CI-verified 2026-07-27:
# eslint dies inside @eslint/config-array→minimatch, backend suite dies via
# archiver's glob chain). No backport exists for the 1.x/2.x majors in-tree.
# Exposure is accepted: consumers are dev tooling plus archiver globbing over
# repo-authored patterns — no untrusted expansion input reaches the library.
# Remove when minimatch/eslint/archiver ship releases compatible with 5.x, or
# a 2.x backport lands; tracked in the same TODO.md deps item.
exec bun audit --audit-level=high \
  --ignore=GHSA-qwww-vcr4-c8h2 \
  --ignore=GHSA-mh99-v99m-4gvg
