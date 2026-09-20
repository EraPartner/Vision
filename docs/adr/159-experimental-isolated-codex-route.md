---
title: Experimental Isolated Codex Route
type: adr
status: accepted
date: 2026-09-20
tags: [adr, codex, ai, privacy, sandbox]
description: Permit a disabled-by-default synthetic App Server experiment behind an isolated macOS process and a bounded local proxy.
---

# ADR-159: Experimental Isolated Codex Route

## Status

Accepted for synthetic experimentation only. Real financial input is outside this decision.

## Date

2026-09-20

## Context

Codex App Server is an official integration surface, but its current documentation calls the
command experimental and unsupported for production workloads. The user chose an experimental
isolated route so Vision can validate a subscription path before release. The main Codex state
and Vision financial files must never be mounted into that experiment.

## Decision

Add an opt-in admin API that starts a separate App Server process on macOS. The process has a
fresh private home, ephemeral credential store, no inherited environment, read-only Codex
policy, and a Seatbelt profile that limits readable files and permits only its private workspace
for writes. A local CONNECT proxy permits only named OpenAI hosts and enforces byte caps. Device
code login occurs inside that process. The only turn accepts a built-in fictional question; the
caller cannot submit a prompt or financial data. App Server tool requests and unrecognized turn
activity fail closed. Logout and a ten-minute expiry dispose of the process and private state.

The route requires an explicit environment flag, Codex binary path, admin bearer token, and
loopback peer. It has no frontend affordance or automatic API-billing fallback.

## Consequences

The offline host test can establish process file and network boundaries before account use.
Provider TLS traffic, complete runtime tool discovery, live account entitlement, logout
behavior, retention, and usefulness still need separate evidence. This ADR does not authorize a
release-ready subscription feature or private-data egress. The disposable login may need to be
repeated after a restart.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/openai-codex-assistance-profiles|OpenAI and Codex Assistance Profiles]]
- [[docs/api/admin|Admin API]]
