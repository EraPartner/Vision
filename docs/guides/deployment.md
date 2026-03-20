---
title: Deployment Guide
type: guide
description: Production deployment instructions
date: 2026-03-18
tags: [guide, deployment, production, docker, electron]
related_code: [[docker-compose.yml]]
---

# Deployment Guide

This guide covers deploying Vision in production environments.

## Deployment Options

Vision supports multiple deployment methods:

| Method | Use Case | Complexity |
|--------|----------|------------|
| Docker Compose | Single server production | Medium |
| Electron Desktop | Local desktop app | Low |
| Manual | Custom infrastructure | High |

## Docker Compose (Recommended)

### Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- Valid SSL certificates (for HTTPS)

### 1. Prepare Environment

```bash
# Clone and navigate to project
git clone <repository-url>
cd Vision

# Create production environment file
cp .env.example .env
```

### 2. Configure Production Variables

Edit `.env` with production settings:

```bash
# Required: Generate a secure database password
POSTGRES_PASSWORD=your-secure-password-here

# Required: Generate a secure secret key
SECRET_KEY=your-application-secret-key

# Server configuration
PORT=3002
LOG_LEVEL=info
CORS_ORIGINS=https://your-domain.com

# Database
DATABASE_URL=postgresql://ftm_user:password@db:5432/financial_transactions
```

### 3. Build and Start

```bash
# Build and start all services
docker compose up -d --build

# View logs
docker compose logs -f app
```

### 4. Verify Deployment

```bash
# Check service status
docker compose ps

# Test API health
curl http://localhost:3002/api/info/health
```

### 5. Setup Nginx (Reverse Proxy)

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /api {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Database Migrations in Production

Migrations run automatically when the container starts via the `docker-entrypoint.sh` script. The entrypoint script:
1. Waits for the PostgreSQL database to be ready
2. Fixes the `alembic_version` column size if needed (supports long revision IDs)
3. Runs Alembic migrations
4. Starts the backend application

If you need to run migrations manually (e.g., for troubleshooting):

```bash
# Run migrations in the app container using the venv Python
docker compose exec app /app/venv/bin/python3 -m alembic -c /app/config/alembic.ini upgrade head
```

## Backup and Restore

### Backup Database

```bash
# Create backup
docker compose exec db pg_dump -U ftm_user financial_transactions > backup.sql

# Compressed backup
docker compose exec db pg_dump -U ftm_user -Fc financial_transactions > backup.dump
```

### Restore Database

```bash
# Restore from plain SQL
docker compose exec -T db psql -U ftm_user financial_transactions < backup.sql

# Restore from compressed dump
docker compose exec -T db pg_restore -U ftm_user -d financial_transactions -c backup.dump
```

## Docker Commands Reference

| Command | Description |
|---------|-------------|
| `docker compose up -d` | Start services in background |
| `docker compose down` | Stop services |
| `docker compose restart` | Restart all services |
| `docker compose logs -f` | Follow logs |
| `docker compose exec app sh` | Shell into app container |
| `docker compose exec db psql` | Database shell |

## Electron Desktop App

### Build Desktop Application

```bash
# Production build
bun run build

# Run Electron (production)
bun run electron:prod

# Clean build
bun run electron:clean
```

### Packaging

The Electron app is in `packaging/electron/`. For packaging into distributable formats, see the electron-builder configuration.

## Environment Variables Reference

### Required Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Database password |
| `SECRET_KEY` | Application secret key |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3002 | Server port |
| `LOG_LEVEL` | info | Logging level (debug, info, warn, error) |
| `CORS_ORIGINS` | http://localhost:5173 | Allowed origins |
| `EXTERNAL_DATABASE` | false | Use external database |

## Security Checklist

- [ ] Change default database password
- [ ] Set secure `SECRET_KEY`
- [ ] Configure `CORS_ORIGINS` properly
- [ ] Enable SSL/TLS
- [ ] Setup regular database backups
- [ ] Configure firewall rules
- [ ] Enable logging and monitoring

## Monitoring

### Health Check

```bash
curl http://localhost:3002/api/info/health
```

### Log Analysis

```bash
# View recent logs
docker compose logs --tail=100 app

# Search logs
docker compose logs app | grep ERROR
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs app

# Verify environment variables
docker compose config
```

### Database Connection Failed

```bash
# Check database container
docker compose ps db
docker compose logs db

# Verify connection
docker compose exec app nc -z db 5432
```

### Out of Memory

```bash
# Check memory usage
docker stats

# Increase memory limit in docker-compose.yml
```

## Related

- [[docs/guides/setup|Setup Guide]] - Local development setup
- [[docs/guides/contributing|Contributing Guide]] - Development contributions
- [[docs/performance/index|Performance Documentation]]
- [[docs/security/index|Security Documentation]]
