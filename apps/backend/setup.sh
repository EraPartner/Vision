#!/bin/bash
# Setup script for backend

cd "$(dirname "$0")"

echo "=== Backend Setup ==="
echo ""

# Check Python
echo "1. Checking Python..."
python3 --version || { echo "Error: Python3 not found"; exit 1; }

# Create venv if needed
if [ ! -d "venv" ]; then
    echo "2. Creating virtual environment..."
    python3 -m venv venv
else
    echo "2. Virtual environment already exists"
fi

# Install dependencies
echo "3. Installing dependencies..."
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# Verify installation
echo ""
echo "4. Verifying installation..."
./venv/bin/python -c "import fastapi; print('✓ FastAPI:', fastapi.__version__)" || echo "✗ FastAPI not installed"
./venv/bin/python -c "import uvicorn; print('✓ Uvicorn:', uvicorn.__version__)" || echo "✗ Uvicorn not installed"
./venv/bin/python -c "import sqlalchemy; print('✓ SQLAlchemy:', sqlalchemy.__version__)" || echo "✗ SQLAlchemy not installed"

echo ""
echo "=== Setup Complete ==="
echo "To start the backend, run: ./venv/bin/python main.py"
