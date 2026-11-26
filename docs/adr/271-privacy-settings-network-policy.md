---
title: "ADR-271: Privacy settings and one network policy"
type: adr
status: accepted
date: 2026-11-26
tags: [adr, privacy, settings, network, swift, native-app, backend, adr-270]
description: "Settings › Privacy in the Swift app: offline mode, per-source switches for prices and research, exchange rates and inflation, an automatic price refresh interval, a daily or manual update check, and AI on this Mac only. The choices live in app_settings; the Bun backend, the Swift backend and the Swift shell enforce them. The Cloudflare 1.1.1.1 reachability probe is removed."
aliases: [adr-271, privacy settings, offline mode, network policy]
related_code:
  [
    "apps/node-backend/src/lib/networkPolicy.ts",
    "apps/node-backend/src/lib/network.ts",
    "apps/node-backend/src/startup/warmup.ts",
    "apps/native/Sources/VisionNativeCore/Settings/NetworkPolicy.swift",
    "apps/native/Sources/VisionBackend/HTTP/NetworkPolicyFetcher.swift",
    "apps/native/Sources/VisionNativeUI/Screens/Settings/NativeSettingsPrivacyView.swift",
  ]
---

# ADR-271: Privacy settings and one network policy

## Status

Accepted on 2026-11-26 by Tor. He asked for the first batch of the privacy settings proposal
(project scratch note `privacy-settings/2026-11-15-privacy-and-preference-settings.md`), with the
settings UI in the Swift app only. On a decision card he allowed policy checks in the Bun backend,
which the Swift app still runs for the operations that are not ported yet
([[docs/adr/270-swift-backend-in-process|ADR-270]]).

## Date

2026-11-26

## Context

Vision contacts outside services on its own: ECB and open.er-api.com for exchange rates, Statbel
and Eurostat for inflation, Yahoo Finance (every hour, with the tickers of every holding), Binance,
Kinesis, custom price addresses, the research providers, GitHub for updates (every five minutes),
logo and news image hosts, and a TCP probe to Cloudflare's 1.1.1.1 before each scheduled refresh.
None of it could be switched off, and `OLLAMA_URL` could point AI prompts off the Mac with no
setting to refuse it.

## Decision

1. **The fields live in `app_settings`.** `offlineMode` (default false), `networkMarketData`,
   `networkExchangeRates`, `networkInflation` (default true), `priceRefresh`
   (`hourly` | `daily` | `manual`, default `hourly`), `updateCheck` (`daily` | `manual`, default
   `daily`) and `aiLocalOnly` (default false). The defaults keep the previous behaviour except the
   update check, which drops from every five minutes to launch plus once a day. A new field in the
   existing blob needs no migration; the backend `SETTING_DEFAULTS` are unchanged, so recorded
   parity corpora stay valid. Reset Preferences in the Swift app keeps these fields.

2. **One policy, three enforcers.**
   - Bun backend: `lib/networkPolicy.ts` reads the fields (at most every two seconds, since the
     Swift app writes `app_settings` without passing through Bun). Each source's fetch helpers go
     through `policyFetch(source, …)`; a blocked call throws `NetworkBlockedError` and the
     existing fallbacks to stored data apply. `installNetworkGuard()` also wraps the global
     `fetch`, so offline mode refuses every non-loopback request from any module, Brave web
     research and the provider health probes included. The Ollama client refuses a non-loopback
     endpoint in offline mode or with `aiLocalOnly`.
   - Swift backend: `NetworkPolicyFetcher` wraps the provider fetcher of the exchange-rate and
     price areas with the same rules, read from the same row. It is applied inside each area's
     `register`, so an area ported later that fetches from a provider wraps its own fetcher there
     with its source.
   - Swift shell: `NetworkAccess` holds the offline switch for the update checker, company logos
     and news thumbnails; the automatic update check runs only with `updateCheck = daily`.

3. **Sources are grouped by what they reveal.** Market data (prices, market lookup, research)
   carries holdings' tickers and is one switch, because one Yahoo client serves all three.
   Exchange rates and inflation send nothing personal and have a switch each.

4. **`priceRefresh` drives the warmup schedule.** `hourly` keeps the launch refresh and the hourly
   quote refresh. `daily` runs both as a daily job (`daily_job_price_refresh`) that the hourly tick
   only checks. `manual` skips the launch refresh, the hourly refresh and the daily holding-gap
   backfill; the user's own refresh still works.

5. **No probe traffic.** `isInternetReachable()` no longer connects to 1.1.1.1. It answers false in
   offline mode, and otherwise true when a network interface has a routable (not link-local)
   address. A network without internet fails at the real request, within that request's timeout.

6. **Electron gets no UI.** The React app keeps its settings as they are; its `app_settings` schema
   keeps unknown fields, so it preserves the choices made in the Swift app, and its backend obeys
   them. Electron's own updater is unchanged.

## Consequences

- Offline mode stops every request the backends and the Swift shell make, except loopback.
- With market data off or `priceRefresh = manual`, prices only change when the user refreshes.
- A captive or broken network is no longer detected before the scheduled refreshes; they fail at
  their own timeouts instead (5 to 30 seconds), as before the 2026-05-03 probe.
- Not done here: the Keychain move for API keys, hide balances, app lock, screen-capture
  protection, a network activity report.
