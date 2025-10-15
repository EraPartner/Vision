#!/usr/bin/env python3
"""
Test script to identify backend startup issues
"""
import sys
import os

# Add backend directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("Testing backend imports...")

try:
    print("1. Testing standard library imports...")
    import tempfile
    from datetime import datetime
    from typing import Optional, List
    print("   ✓ Standard library OK")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

try:
    print("2. Testing FastAPI imports...")
    from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Query, Body
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
    print("   ✓ FastAPI OK")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

try:
    print("3. Testing SQLAlchemy imports...")
    from sqlalchemy.orm import Session
    print("   ✓ SQLAlchemy OK")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

try:
    print("4. Testing database.connection imports...")
    from database.connection import get_db, init_db
    print("   ✓ Database connection OK")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

try:
    print("5. Testing services.bank_adapters imports...")
    from services.bank_adapters import BankAdapterFactory
    print("   ✓ Bank adapters OK")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

try:
    print("6. Testing services.transaction_service imports...")
    from services.transaction_service import TransactionImportService
    print("   ✓ Transaction service OK")
except Exception as e:
    print(f"   ✗ Error: {e}")
    sys.exit(1)

try:
    print("7. Testing main.py imports...")
    import main
    print("   ✓ main.py imports OK")
except Exception as e:
    print(f"   ✗ Error importing main.py: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n✓ All imports successful!")
print("\nTrying to start the server...")

try:
    import uvicorn
    print("Starting uvicorn...")
    uvicorn.run(main.app, host="0.0.0.0", port=8000)
except Exception as e:
    print(f"✗ Error starting server: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
