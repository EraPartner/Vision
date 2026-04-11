---
title: Troubleshooting & FAQ
type: reference
status: active
date: 2026-03-31
tags: [troubleshooting, faq, reference, debugging]
description: Common issues, error messages, and their solutions for the Vision project
aliases: [troubleshooting, FAQ, common issues, errors, debugging, problems]
---

# Troubleshooting & FAQ

> [!abstract] Purpose
> Common issues, error messages, and their solutions. Organized by area for quick lookup.

## Setup & Development

### PostgreSQL won't start

**Symptom:** `bun run docker:dev` fails because the database service does not become healthy.

**Solutions:**
1. Check db container logs: `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs db`
2. Verify container status: `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps`
3. If state is corrupted, reset dev volumes: `bun run docker:clean:reset`
4. Ensure Docker Desktop is running and has enough disk space

### Database connection refused

**Symptom:** `DATABASE_URL` connection fails.

**Solutions:**
1. Verify PostgreSQL container is running: `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db`
2. Check `DATABASE_URL` in `.env.local` matches the actual connection string
3. Default local backend URL: `postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions`

### Migration fails

**Symptom:** `bun run db:upgrade` throws an error.

**Solutions:**
1. Check current version: `alembic current`
2. View pending migrations: `alembic history --verbose`
3. If stuck mid-migration, Alembic auto-rolls back (PostgreSQL transactional DDL)
4. For manual recovery: `alembic downgrade -1` then retry

### Port already in use

**Symptom:** `EADDRINUSE` on port 3002 (backend) or 5173 (frontend).

**Solutions:**
1. Find the process: `lsof -i :3002` or `lsof -i :5173`
2. Kill it: `kill <PID>`
3. Or change the port in `.env.local`

## Database

### Schema mismatch after migration

**Symptom:** App errors about missing columns or tables.

**Solutions:**
1. Run `alembic upgrade head` to apply all pending migrations
2. Check `alembic_version` table for current schema version
3. If `schemaInit.js` and migrations diverge, the migration path is authoritative

### Sequence drift on portfolio transactions

**Symptom:** Duplicate key error on `portfolio_transactions_base_id_seq`.

**Solutions:**
1. The repository auto-heals this by resyncing the sequence
2. If it persists: `SELECT setval('portfolio_transactions_base_id_seq', (SELECT MAX(id) FROM portfolio_transactions_base) + 1);`

## Frontend

### Charts not rendering

**Symptom:** Dashboard or portfolio charts show empty.

**Solutions:**
1. Check browser console for errors
2. Verify API is running and returning data
3. Check widget visibility settings (user may have hidden the widget)
4. Clear React Query cache: dev tools → "Clear Cache"

### Virtual table not updating after mutation

**Symptom:** Added/deleted transaction doesn't appear in table.

**Solutions:**
1. Ensure React Query invalidation includes the correct query key:
   - `transactions` for standard table
   - `transactions-virtual` for virtual table
2. Check network tab for failed API responses

### Search not working in virtual table

**Symptom:** Typing in search box doesn't filter results.

**Solutions:**
1. Check if `onSearchChange` callback is properly wired
2. Verify search query is being sent to the API
3. Check for 200ms debounce delay (search is not instant)

## Backend

### Rate limit exceeded

**Symptom:** `429 Too Many Requests` responses.

**Solutions:**
1. Standard limit: 100 req/min, export/patch: 30 req/min
2. Check `X-RateLimit-*` headers for current usage
3. Increase limits in middleware config if needed (development only)

### Import fails on large files

**Symptom:** CSV import times out or fails for large files.

**Solutions:**
1. Use the streaming import endpoint: `POST /api/import/csv/stream`
2. Streaming import processes in batches of 20 rows
3. Check server memory limits for very large files (>100K rows)

### Price provider returns stale data

**Symptom:** Investment prices not updating.

**Solutions:**
1. Price cache TTL: 5 minutes for live prices
2. Force refresh: call `POST /api/admin/investments/update-prices`
3. Check provider configuration in `priceProviderService.js`
4. For Kinesis spikes: use `POST /api/admin/investments/kinesis/sanitize-history`

## Docker & Deployment

### Container won't start

**Symptom:** `docker compose up` fails.

**Solutions:**
1. Check logs: `docker compose logs app`
2. Verify `.env` file exists with required variables
3. Check container state and restarts: `docker compose ps`
4. Check port conflicts on host: `lsof -i :3002` and `lsof -i :5432`

### Database not initialized in Docker

**Symptom:** App starts but tables are missing.

**Solutions:**
1. The `docker-entrypoint.sh` runs `alembic upgrade head` on startup
2. Check entrypoint logs for migration errors
3. If fresh install, `schemaInit.js` bootstraps the schema when `alembic_version` table doesn't exist

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `VALIDATION_ERROR` | Request body failed validation | Check required fields and types in API docs |
| `DUPLICATE_ENTRY` | Trying to create a duplicate record | Check deduplication logic or use update instead |
| `NOT_FOUND` | Resource doesn't exist | Verify ID and check if soft-deleted |
| `RATE_LIMITED` | Too many requests | Wait and retry, check rate limits |
| `INTERNAL_ERROR` | Server-side bug | Check server logs, report with reproduction steps |

## Related

- [[docs/guides/setup\|Setup Guide]] - Full setup instructions
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[docs/api/index\|API Documentation]] - Endpoint reference
- [[docs/guides/migrations\|Migration Guide]] - Database migration management
