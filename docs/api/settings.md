---
title: API - Settings
type: endpoint
method: GET, POST, PATCH
path: /api/settings
description: User preferences and application settings
date: 2026-03-18
tags: [api, settings, preferences]
related_code: [[apps/node-backend/src/routes/settings.js]]
---

# Settings API

## Overview

The Settings API manages user preferences stored as key-value JSON.

## Endpoints

### GET /api/settings

Get all settings.

**Response:**
```json
{
  "theme": "dark",
  "language": "en",
  "currency": "EUR",
  "date_format": "DD/MM/YYYY"
}
```

### GET /api/settings/:key

Get a specific setting.

### POST /api/settings

Set a setting.

**Request Body:**
```json
{
  "key": "theme",
  "value": "dark"
}
```

### PATCH /api/settings/:key

Update a setting.

## Common Settings

| Key | Type | Description |
|-----|------|-------------|
| theme | string | "light" or "dark" |
| language | string | "en" or "nl" |
| currency | string | Default currency (ISO 4217) |
| date_format | string | Date display format |
| belgian_tax_profile | object | Belgian tax profile settings |

## Related

- [[docs/adr/002-database-schema|Database Schema]]
