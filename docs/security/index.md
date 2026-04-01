---
title: Security Documentation Index
type: security-index
status: active
date: 2026-03-31
tags: [security, index, validation, rate-limiting]
description: Security practices and policies for the Vision application including input validation and rate limiting
aliases: [security, security docs, input validation, rate limiting]
---

# Security Documentation

Security practices and policies for Vision.

## Areas

```dataview
TABLE title, description
FROM "docs/security"
WHERE type = "security"
SORT title ASC
```

## Topics

- [[docs/security/input-validation|Input Validation]] - Input sanitization and validation
- [[docs/security/rate-limiting|Rate Limiting]] - Request rate controls
- Authentication and authorization (future)
- Data protection (future)
