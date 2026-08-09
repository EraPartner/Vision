---
title: Feature - Onboarding
type: feature
status: active
date: 2026-04-19
updated: 2026-08-09
tags: [feature, onboarding, wizard, first-run, phase-9, backup, encrypt, passphrase, phase-2]
description: First-run onboarding wizard for new Vision users
aliases: [onboarding, setup wizard, first-run, welcome]
related_code: ["apps/frontend/src/components/onboarding/OnboardingWizard.tsx", "apps/frontend/src/App.tsx"]
---

# Feature: Onboarding

## Overview

The Onboarding Wizard guides new users through initial setup of Vision, ensuring they configure essential settings before using the application.

---

## Components

### OnboardingWizard

**Location:** `apps/frontend/src/components/onboarding/OnboardingWizard.tsx`

A multi-step wizard (`STEP_KEYS` in `OnboardingWizard.tsx`) that covers, in order:

1. **Welcome** — Introduction to Vision, with an early restore-from-backup offer for migrating users
2. **Overview** — What Vision can do (budgeting + portfolio feature map)
3. **Categories** — Create suggested spending categories
4. **Bank Setup** — Pick the bank adapter for CSV imports
5. **Import** — Import the first bank CSV (a first import typically answers 202 and hands off to the review page)
6. **Feature Tour** — Clickable feature tiles that end onboarding at the chosen page
7. **Backup** — Set a backup location, or restore from an existing backup

Categories deliberately run *before* the import step: a first import lands on the
review page (every recipient is new on an empty database), and the review page is
where categories get assigned — so the user must arrive there with categories
already created. Taking the review hand-off from the import step ends onboarding
at step 5 of 7 (tour and backup are skipped; the wizard can be replayed from
Settings → About).

---

## Trigger Conditions

The onboarding wizard is shown when:
- No transactions exist in the database
- User has not completed onboarding before

It can be restarted from **Settings → App → Setup Wizard**.

---

## Settings Configured

The wizard configures the following `user_settings` keys:

| Key | Type | Description |
|-----|------|-------------|
| `language` | string | `en` or `nl` |
| `defaultCurrency` | string | ISO 4217 currency code |
| `numberFormat` | string | `en-US` or `nl-NL` |
| `dateFormat` | string | Date format pattern |
| `startOfWeek` | number | 0 (Sunday) or 1 (Monday) |
| `showDecimalPlaces` | boolean | Show decimal places in currency |
| `defaultPageSize` | number | Default table page size |
| `widget_visibility` | JSONB | Dashboard widget visibility |

---

## Context Integration

Settings configured during onboarding are stored in:
- `AppSettingsContext` — Global app settings
- `SettingsContext` — Settings management
- `SettingsPreloadContext` — Preloads settings before app renders

---

## Error Handling (Phase 9)

When the wizard fails to persist settings to the backend, users see a toast error with the message from translation key `onboarding.persist.failed`. The `useOnboarding()` hook catches errors during `complete()` and `reset()` operations, logs them to the error logger, and presents the user-facing toast.

---

## Encrypted Backup Restore in Onboarding

The **RestoreFromBackupCard** in the onboarding wizard now supports encrypted backup files:

- **File selection**: User picks a `.visionbak` or `.visionbak.enc` file to restore
- **Encryption detection**: System inspects the file header to determine if encryption is needed
- **Passphrase modal**: If encrypted, a modal prompts for the backup passphrase before restore begins
- **Error recovery**: Wrong passphrase shows an error message with prompt to retry; network errors show informative toast
- **Fallback passphrases**: Respects `VISION_BACKUP_PASSPHRASE` env var and OS keychain (Electron safeStorage) if available
- **No friction for unencrypted**: Unencrypted backups restore immediately without modal

This provides a seamless UX for first-time users who may have encrypted backups from previous Vision instances.

## Related

- [[docs/api/settings]] — Settings API
- [[docs/features/views#settings]] — Settings in views
- [[docs/features/backup-coverage-audit]] — Backup system and encryption details
- [[docs/features/settings#backup--restore-with-encryption-phase-2-ux]] — Backup/restore in Settings
- [[docs/i18n/translations#recent-keys-added]] — Translation keys including passphrase modal keys
- [[apps/frontend/src/contexts/AppSettingsContext.tsx]] — App settings context
