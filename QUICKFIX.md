# Quick Start Guide

## The Problem
FastAPI is installed but your fish shell isn't activating the virtual environment correctly.

## Solution: Manual Setup

### Step 1: Install Backend Dependencies
Open a new terminal and run these commands:

```bash
cd apps/backend

# Use the venv python directly (no activation needed)
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# Verify installation
./venv/bin/python -c "import fastapi; print('FastAPI OK')"
```

### Step 2: Start Backend
```bash
# From apps/backend directory
./venv/bin/python main.py
```

You should see: `Uvicorn running on http://0.0.0.0:8000`

### Step 3: Start Frontend (in new terminal)
```bash
# From project root
npm run dev
```

Visit: http://localhost:8080

## Alternative: Use the Setup Script

```bash
cd apps/backend
bash setup.sh
```

This will install everything and verify the installation.

## If You Still Get "Module Not Found"

The issue is that your shell (fish) isn't properly activating bash's `source` command.

**Solution**: Use the venv python directly:

Instead of:
```bash
source venv/bin/activate
python main.py
```

Do this:
```bash
./venv/bin/python main.py
```

This bypasses shell activation entirely and uses the venv's python directly.

## Summary of Changes Made

✅ Added FastAPI, uvicorn, pydantic to requirements.txt
✅ Updated start.sh to use `bash -c` for activation
✅ Fixed syntax error in main.py (missing closing parenthesis)
✅ Created frontend-compatible API endpoints at `/api/*`
✅ Added CORS support for localhost
✅ Removed authentication completely
✅ Removed Supabase

Your app is ready - you just need to install the dependencies using the commands above!
