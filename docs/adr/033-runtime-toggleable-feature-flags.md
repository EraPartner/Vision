---
title: ADR-033 - Runtime-Toggleable Feature Flags
type: adr
status: Superseded
date: 2026-04-23
tags: [adr, backend, feature-flags, admin, phase-4, runtime-toggles, gradual-rollout]
description: Persistent feature flags in PostgreSQL (feature_flags table) with admin API endpoints to toggle flags at runtime without redeployment. Replaces hard-coded environment variable checks (AI_CHAT_ENABLED, AGGREGATIONS_V2_ENABLED) with DB-persisted toggles.
aliases: [adr-033, feature-flags, runtime-toggles]
related_code:
  - alembic/versions/0002_feature_flags.py
  - apps/node-backend/src/repositories/featureFlagRepository.js
  - apps/node-backend/src/services/featureFlagService.js
  - apps/node-backend/src/routes/admin.js
---

# ADR-033: Runtime-Toggleable Feature Flags

## Status
Superseded by [[035-remove-feature-flags]]

## Date
2026-04-23

## Context

### Previous Approach

Feature gates were hard-coded as environment variables:
- `AI_CHAT_ENABLED` — Enables AI chat routes
- `AGGREGATIONS_V2_ENABLED` — Enables new aggregations pipeline

**Problems:**

1. **Requires redeployment** — Toggling a feature requires:
   - Update `.env`
   - Rebuild/redeploy the application
   - Restart the service

2. **No audit trail** — No record of who toggled a feature or when.

3. **Risk of inconsistency** — Environment-based toggles can differ between dev/staging/prod, causing surprises during promotion.

4. **Difficult A/B testing** — Can't enable a feature for some users without code changes.

5. **No runtime introspection** — API clients can't query which features are available.

### Use Cases for Runtime Toggles

- **Gradual rollout**: Enable a feature for 10% of requests, monitor, then increase
- **Emergency disable**: Disable a problematic feature immediately without redeployment
- **Admin control**: Allow non-engineers to toggle features via UI
- **Experimentation**: A/B test features against control group

## Decision

### 1. Feature Flags Table

Create `feature_flags` table in PostgreSQL:

```sql
CREATE TABLE feature_flags (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_feature_flags_key ON feature_flags(key);

-- Trigger to auto-update updated_at
CREATE TRIGGER set_feature_flags_updated_at
  BEFORE UPDATE ON feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

### 2. Seed Default Flags in Migration

```python
# alembic/versions/0002_feature_flags.py
op.execute("""
  INSERT INTO feature_flags (key, enabled, description) VALUES
    ('ai_chat', false, 'Enable AI chat / Ollama integration'),
    ('aggregations_v2', false, 'Enable aggregations V2 data processing pipeline')
  ON CONFLICT (key) DO NOTHING;
""")
```

Each flag starts **disabled by default**; admins enable as needed.

### 3. Repository Layer

Location: `[[apps/node-backend/src/repositories/featureFlagRepository.js|featureFlagRepository.js]]`

```javascript
async function isEnabled(key) {
  const flag = await findByKey(key);
  return flag?.enabled ?? false;  // Safe: unknown keys default to false
}

async function setEnabled(key, enabled) {
  const result = await query(
    `UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE key = $1 RETURNING *`,
    [key, enabled]
  );
  return result.rows[0] ?? null;
}
```

**Key design:**
- `isEnabled()` returns **false for unknown keys** (safe default; prevents crashes on typos)
- Parameterized queries (prevents SQL injection)
- All mutations return the updated flag record

### 4. Service Layer

Location: `[[apps/node-backend/src/services/featureFlagService.js|featureFlagService.js]]`

```javascript
async function isFeatureEnabled(key) {
  return featureFlagRepository.isEnabled(key);
}

async function setFeatureFlag(key, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new ValidationError('enabled must be a boolean');
  }

  // Verify flag exists (don't create new flags via API)
  const existing = await featureFlagRepository.findByKey(key);
  if (!existing) {
    throw new NotFoundError(`Feature flag '${key}' not found`);
  }

  const updated = await featureFlagRepository.setEnabled(key, enabled);
  logger.info('Feature flag updated', { key, enabled });
  return updated;
}
```

### 5. Admin API Endpoints

Location: `[[apps/node-backend/src/routes/admin.js|admin.js]]`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/feature-flags` | List all flags with current state |
| GET | `/api/admin/feature-flags/:key` | Get single flag |
| PATCH | `/api/admin/feature-flags/:key` | Toggle a flag |

Example:
```javascript
router.patch('/feature-flags/:key', async (req, res) => {
  const { key } = req.params;
  const { enabled } = req.body;

  if (enabled === undefined) {
    throw new ValidationError('Request body must include "enabled" (boolean)');
  }

  const updated = await setFeatureFlag(key, enabled);
  res.ok(updated);
});
```

### 6. Usage in Routes

Check the flag at route level or service level:

```javascript
// Route level
if (await isFeatureEnabled('ai_chat')) {
  router.post('/api/ai/chat', aiChatHandler);
}

// Service level
async function maybeExecuteFeature(key, fn) {
  if (!(await isFeatureEnabled(key))) {
    throw new NotFoundError(`Feature ${key} is not enabled`);
  }
  return fn();
}
```

## Consequences

### Positive

- **Zero-downtime toggles** — Enable/disable features without redeployment
- **Audit trail** — Logs capture who toggled what and when
- **Gradual rollout** — Can enable for subset of users (future: add `enabled_for` column)
- **Safe defaults** — Unknown flags default to disabled; typos don't cause crashes
- **Admin control** — Non-engineers can toggle via API or dashboard UI
- **Operational safety** — Can immediately disable a broken feature in production

### Negative

- **Cache invalidation** — Server must re-query flag on each check (fast; single row lookup)
- **Database dependency** — Flag availability depends on database connectivity (degrade gracefully)
- **No client-side control** — Flags are server-enforced; no client-side preview
- **Manual seeding** — New flags must be explicitly inserted in migration (prevents accidental flags)

### Neutral

- **Environment vars still work** — Code can check both env vars and flags; DB overrides env
- **No built-in percentile rollout** — Current schema is boolean; percentile rollout requires UI/business logic elsewhere

## Implementation Timeline

**Phase 4 (2026-04-23):**
- Create `feature_flags` table via Alembic migration
- Seed `ai_chat` and `aggregations_v2` flags (disabled by default)
- Implement repository and service layers
- Add admin API endpoints (GET/PATCH)
- Update routes to check flags before conditionally mounting handlers

**Future (Phase 5+):**
- Add `enabled_for_percentage` column for gradual rollout
- Add UI dashboard to toggle flags
- Add event logging for flag changes (audit trail)
- Consider caching with TTL if query frequency becomes a bottleneck

## Adding New Feature Flags

1. **In migration:**
   ```python
   op.execute("""
     INSERT INTO feature_flags (key, enabled, description) VALUES
       ('my_new_feature', false, 'Description here')
     ON CONFLICT (key) DO NOTHING;
   """)
   ```

2. **In code:**
   ```javascript
   if (await isFeatureEnabled('my_new_feature')) {
     // Feature code here
   }
   ```

3. **Toggle via API:**
   ```bash
   curl -X PATCH http://localhost:3000/api/admin/feature-flags/my_new_feature \
     -H "Content-Type: application/json" \
     -d '{"enabled": true}'
   ```

## Related

- [[docs/reference/api-endpoint-matrix#admin|Admin API Endpoints]]
- [[docs/reference/code-patterns#feature-flag-pattern-backend-phase-4|Feature Flag Pattern Reference]]
- [[docs/features/ai-chat|AI Chat Feature]] (uses `ai_chat` flag)
- [[docs/features/aggregations|Aggregations Feature]] (uses `aggregations_v2` flag)
- [[docs/adr/035-remove-feature-flags|ADR-035: Remove Feature Flags]] — supersedes this ADR
- [[docs/adr/index|All ADRs]]
