---
title: "ADR-210: Move the backend into the Mac app in Swift"
type: adr
status: proposed
date: 2026-10-18
tags: [adr, architecture, swift, native-app, backend, hummingbird, openapi, macos]
description: "Proposed on 2026-10-18. Vision becomes a Mac app: the TypeScript backend is replaced, route by route behind openapi.yaml, by a Swift backend built on Hummingbird 2 and PostgresNIO that runs inside the app process. PostgreSQL stays a supervised process; Docker/Linux and Electron keep the TypeScript backend until they are retired."
aliases: [adr-210, swift backend]
---

# ADR-210: Move the backend into the Mac app in Swift

## Status

Proposed on 2026-10-18 by Tor, who chose the direction (Mac only, Swift with Hummingbird, in the
app process) and asked for the decision record before any code. Accepting it is a separate step,
and every stage below stays default-off until CI proves it, as with ADR-206 to ADR-208.
[[docs/adr/205-vision-native-hand-over|ADR-205]]'s real-data switch-over rule is unchanged.

## Date

2026-10-18

## Context

Since [[docs/adr/208-vision-native-without-web-content|ADR-208]] and
[[docs/adr/209-vision-native-retire-helper-document|ADR-209]] the Debug Demo shows no web content,
so TypeScript's remaining job in the native app is the backend: about 126,000 lines in
`apps/node-backend/src` (43 route modules, 309 operations in `openapi.yaml`), run by the native
supervisor as a separate Node process with its own runtime in the payload. Its dependencies are
few: Express, `pg`, `decimal.js`, CSV/Excel/XML parsing, zip, Puppeteer with a bundled headless
Chrome for PDF reports, a Yahoo Finance client, and the Ollama/OpenAI/Codex integrations.

Tor wants a performant, well-supported, type-safe and memory-safe backend for a Mac-only Vision.
Rust and Swift were compared: Rust offers compile-time-checked SQL (`sqlx`) and the strongest
Linux story; Swift offers one language with the app, shared code with the calculations already
ported in ADR-208, server and client generated from the same OpenAPI contract, and a backend
that can run inside the app. For a Mac-only app the last three outweigh Rust's advantages.

## Decision

1. **Language and stack:** Swift 6 with strict concurrency, Hummingbird 2, PostgresNIO with plain
   SQL (no ORM), Foundation `Decimal` for money, and `swift-openapi-generator` producing the
   server protocol from `openapi.yaml`, the same contract the app's client is generated from.
2. **In the app process:** the backend is a Swift package target (`VisionBackend`) that the app
   starts on its own actors. It serves HTTP on the supervised loopback origin so the retained web
   page and existing tools keep working; native screens may call it through an in-process
   transport instead of the network. PostgreSQL stays a separate supervised process. A backend
   fault therefore takes the window with it, which the tests and the strict-concurrency checks
   must make up for.
3. **Route by route behind the contract:** the Swift server answers the operations it owns and
   forwards every other request to the supervised Node backend, which keeps running until the
   last operation moves. Each moved operation must pass the existing backend tests' cases,
   translated, and a parity run against the Node answer on the synthetic Demo data. A switch
   (default-off, Debug Demo first) selects the Swift owner per release.
4. **Order:** read-only reference data first (exchange rates, accounts, categories), then
   transactions and imports, then portfolio and prices, then Belgian tax and reports, then
   scheduled jobs (daily jobs, warm-up, analysis monitors, the cash-flow forecast), then the AI
   integrations. Calculations already in Swift are shared, not copied.
5. **Reports without Chrome:** PDF reports render natively (as the app's print path already
   does), so Puppeteer and the bundled Chrome Headless Shell leave the payload when reports move.
6. **Mac only:** backend code may use Apple frameworks. Docker/Linux and the Electron app keep the
   TypeScript backend until their own retirement decision; until then `openapi.yaml` stays the
   single contract both backends implement.

## Open questions (before acceptance)

- **Migrations:** Alembic (Python, bundled in the payload) stays the schema owner for now; moving
  migrations to Swift needs its own decision because the schema is a persistence contract.
- **Excel:** reading `.xlsx` has Swift libraries; whether the backend writes Excel, and with what,
  is not yet checked.
- **Security properties:** the admin token, CSRF and host guards and rate limits must keep their
  meaning when the caller is in-process; each gets a test before its routes move.
- **Fault isolation:** whether a crash-isolating helper process is needed after all is decided by
  the first stages' evidence, not assumed.

## Consequences

- Node, its runtime and Chrome leave the Mac bundle once the last operation moves; the app runs
  one fewer process. Memory and bundle size are measured per stage with `install-native.sh
  --measure` and the e2e smoke, against the numbers in the native handoff.
- For the duration of the migration two backends implement one contract; a contract change must
  land in both until the Node backend is retired.
- Vision stops being a Docker-deployable server on the native path; that product change belongs
  to the later Docker/Electron retirement decision.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Vision Native]]
- [[docs/adr/205-vision-native-hand-over|ADR-205: Vision Native hand-over]]
- [[docs/adr/208-vision-native-without-web-content|ADR-208: Finish phase 4 without web content]]
- [[docs/adr/209-vision-native-retire-helper-document|ADR-209: Retire the helper document]]
- [[docs/reference/native-parity/agent-handoff|Vision Native agent handoff]]
