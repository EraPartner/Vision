---
title: Feature - Onboarding
type: feature
status: active
date: 2026-04-19
tags: [feature, onboarding, wizard, first-run, phase-9]
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

A multi-step wizard that covers:

1. **Welcome** — Introduction to Vision
2. **Language** — Select display language (English/Dutch)
3. **Currency** — Set default currency
4. **Number Format** — Choose number formatting (US/EU)
5. **Date Format** — Choose date display format
6. **First Import** — Option to import first bank CSV
7. **Complete** — Ready to use

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

## Related

- [[docs/api/settings]] — Settings API
- [[docs/features/views#settings]] — Settings in views
- [[docs/i18n/translations#recent-keys-added]] — New i18n key `onboarding.persist.failed`
- [[apps/frontend/src/contexts/AppSettingsContext.tsx]] — App settings context
