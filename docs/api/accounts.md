---
title: API - Accounts
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/accounts
description: Account entity management (ADR-088) — the user's own accounts spanning budgeting cash, portfolio holdings, and liabilities
date: 2026-06-18
tags: [api, accounts, account-entity, adr-088, net-worth, cash-sleeve]
status: active
aliases: [accounts-api, account-management, account-entity]
related_code: [[apps/node-backend/src/routes/accounts.js]], [[apps/node-backend/src/services/accountService.js]], [[apps/node-backend/src/repositories/accountRepository.js]]
---

# Accounts API

## Overview

Accounts (ADR-088) replace the implicit free-text `bank_account` string with a real entity that
is the spine across all three workspaces — budgeting cash (the transactions ledger), portfolio
holdings, and liabilities. An account is the user's *own* account; this is distinct from
`recipient_bank_accounts` (counterparty IBANs).

During the dual-write phase a database trigger (migration 0051) keeps `transactions.account_id`
and `planned_transactions.account_id` in sync with the `bank_account` string; writers therefore
don't have to set `account_id` directly yet. The orthogonal flag columns
(`type` / `liquidity_class` / `spendable` / `in_net_worth` / `tax_wrapper` / `owner` /
`multi_currency_cash` / `has_cash_sleeve`) exist from migration 0050; their behaviour is
activated in ADR-089.

## Endpoints

### GET /api/accounts

List accounts.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| active | `true` \| `false` \| `all` | `true` | Filter by active status |

Returns `{ items: Account[], total, links }`.

### GET /api/accounts/:id

Fetch a single account (404 if not found).

### POST /api/accounts

Create an account. Body: `AccountCreate` (`name` required; all flags optional, falling back to
DB defaults — `type='checking'`, `owner='me'`, `in_net_worth=true`, `has_cash_sleeve=true`).
`currency` is validated as ISO-4217 and uppercased. Returns `201` with the created account, or
`409` if an account with that name already exists.

### PATCH /api/accounts/:id

Partial update (`AccountUpdate`). `404` if not found, `409` on name collision.

### DELETE /api/accounts/:id

Delete an account. Because the `account_id` FKs are `ON DELETE RESTRICT`, an account that still
has transactions, planned transactions, or portfolio lots cannot be deleted — the API returns `409`
with a message to **archive** it instead (set `is_active=false` via PATCH). `404` if not found.

> [!tip] Close-account workflow
> Use `CloseAccountDialog` (wired into `AccountsPage`) to transfer all portfolio lots in-specie to
> another account via `POST /api/investments/:id/move`, then archive with `PATCH /api/accounts/:id`
> `{ is_active: false }`. This is the recommended path for a brokerage account you are closing.

### POST /api/accounts/:id/merge

Merge one or more **source** accounts into this **survivor** (`:id`). Body
`{ source_ids: number[] }`. In one transaction (`accountMergeService`), every reference to a
source is repointed to the survivor — `transactions.account_id` + `bank_account` (set to the
survivor's name so the dual-write trigger keeps it merged), `planned_transactions`, portfolio lots
(`portfolio_transactions_base.account_id`, cascading to child tables, or the flat table), and any
`accounts.funding_account_id` — then the sources are deleted. Returns
`{ into, merged, reassigned: { transactions, planned, portfolio, funding } }`. `404` if the
survivor or any source is missing. Irreversible (the source rows are gone; identity lives on
`account_id`). Used to unify e.g. an old literal `'KBC'` account into its IBAN account after the
ADR-088 adapter change.

## Data model

See [[docs/reference/data-model#Account|Account]] and [[docs/adr/088-account-entity|ADR-088]].
