# Python 3.14 Compatibility Issue - SOLVED

## Problem
Python 3.14 is too new (released in 2025) and many packages don't have pre-built wheels yet:
- `pandas 2.1.4` - Build fails with Cython/Python 3.14 incompatibility
- `pydantic-core` - Rust compilation fails with Python 3.14
- `psycopg2-binary` - No wheels available for Python 3.14

## Solution
Use Python 3.10-3.13 (stable, well-supported versions).

## How to Install Python 3.13

### macOS (Homebrew)
```bash
brew install python@3.13
```

### macOS (Official Installer)
Download from https://www.python.org/downloads/

### Ubuntu/Debian
```bash
sudo apt update
sudo apt install python3.13 python3.13-venv
```

### Check Installed Versions
```bash
python3.13 --version
# or
python3.12 --version
python3.11 --version
python3.10 --version
```

## Updated Start Script
The `start.sh` script now automatically:
1. Detects compatible Python versions (3.10-3.13)
2. Uses bash for venv activation (fixes Fish shell issues)
3. Shows clear error if no compatible version found

## Manual Setup (if needed)

```bash
cd apps/backend

# Use specific Python version
python3.13 -m venv venv
source venv/bin/activate  # bash/zsh
# or
source venv/bin/activate.fish  # fish shell

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Start server
python main.py
```

## What Was Fixed
1. ✅ Created missing `.env` file in `apps/backend/`
2. ✅ Updated `requirements.txt` to use `pandas>=2.2.0` (better Python 3.14 support)
3. ✅ Made `psycopg2-binary` optional (not needed for SQLite)
4. ✅ Updated `start.sh` to detect Python 3.10-3.13 automatically
5. ✅ Fixed Fish shell incompatibility by using bash for activation

## Recommended Python Versions
- **Best**: Python 3.12 or 3.13 (latest stable)
- **Good**: Python 3.11 (mature, well-tested)
- **OK**: Python 3.10 (still supported)
- **❌ Avoid**: Python 3.14 (too new, package ecosystem not ready)

## Try the Fixed Start Script
```bash
./start.sh
```

It will now:
- Automatically find compatible Python
- Show which version it's using
- Display helpful error if Python 3.14 is the only version available
