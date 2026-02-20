#!/usr/bin/env python3
"""
Check Alembic status helper.

Prints:
 - the configured DATABASE URL coming from app settings
 - alembic heads (latest revision in repo)
 - alembic current (applied revision in DB)
 - contents of alembic_version table (if present)
 - an explicit UP-TO-DATE / NOT UP-TO-DATE line

Usage:
    python3 scripts/check_alembic_status.py
"""
import os
import subprocess
import sys

# Make sure project root (backend/) is on sys.path so imports resolve
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config.config import get_settings
from sqlalchemy import create_engine, inspect, text

s = get_settings()
url = s.database.url
print("Configured DATABASE URL:", url)

# Run alembic heads and current via subprocess so we mirror CLI behaviour
try:
    heads = subprocess.check_output(["alembic", "heads"], stderr=subprocess.STDOUT, text=True)
except subprocess.CalledProcessError as e:
    heads = e.output

try:
    current = subprocess.check_output(["alembic", "current"], stderr=subprocess.STDOUT, text=True)
except subprocess.CalledProcessError as e:
    current = e.output

print('\n=== alembic heads ===')
print(heads.strip() or '(no output)')
print('\n=== alembic current ===')
print(current.strip() or '(no output)')

# Try to connect and inspect alembic_version
try:
    engine = create_engine(url, pool_pre_ping=True)
    print('\nEngine dialect:', engine.dialect.name)
    inspector = inspect(engine)
    tables = [t.lower() for t in inspector.get_table_names()]
    print('Tables in DB:', tables)
    if 'alembic_version' in tables:
        with engine.connect() as conn:
            try:
                r = conn.execute(text('select * from alembic_version'))
                rows = r.fetchall()
                print('alembic_version rows:', rows)
            except Exception as e:
                print('Error querying alembic_version:', e)
    else:
        print('alembic_version table NOT present in DB')
except Exception as e:
    print('Error connecting to DB:', e)

# Simple compare: extract first token (revision id) from heads and current outputs
import re

h = re.search(r"([0-9a-fA-F_]+)\s*\(head\)", heads)
if h:
    head_rev = h.group(1)
else:
    # try to find any hex-like rev id
    m = re.search(r"([0-9a-f]{6,40})", heads)
    head_rev = m.group(1) if m else None

c = re.search(r"([0-9a-f]{6,40})", current)
current_rev = c.group(1) if c else None

print('\nSummary:')
if head_rev and current_rev:
    if head_rev == current_rev:
        print('  ✓ UP-TO-DATE: DB is at head', head_rev)
        sys.exit(0)
    else:
        print('  ✗ NOT up-to-date: head=', head_rev, 'current=', current_rev)
        sys.exit(2)
elif head_rev and not current_rev:
    print('  ✗ No current revision applied to DB, head=', head_rev)
    sys.exit(2)
elif not head_rev:
    print('  ✗ Could not determine head revision from alembic heads output')
    sys.exit(3)
else:
    print('  ✗ Unknown state')
    sys.exit(4)
