#!/bin/bash

echo "🚀 Starting Finance Tracker..."
echo ""

# Start backend API
echo "📦 Starting Python backend API..."
cd apps/backend

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "❌ Error: Virtual environment not found at apps/backend/venv"
    echo "Please create it first:"
    echo "  cd apps/backend"
    echo "  python3 -m venv venv"
    echo "  ./venv/bin/pip install -r requirements.txt"
    exit 1
fi

echo "✓ Using virtual environment at apps/backend/venv"

# Install/update dependencies using venv's pip directly (no activation needed)
echo "Installing/updating dependencies..."
./venv/bin/pip install --upgrade pip > /dev/null 2>&1
./venv/bin/pip install -r requirements.txt > /dev/null 2>&1

# Start the backend API server using venv's python directly
echo "✓ Starting FastAPI server on http://localhost:3002"
./venv/bin/python main.py > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
cd ../..

# Wait for backend to start
echo "Waiting for backend to be ready..."
sleep 3

# Check if backend is running
if curl -s http://localhost:3002/ > /dev/null 2>&1; then
    echo "✓ Backend API is running"
else
    echo "⚠ Backend may not have started correctly. Check /tmp/backend.log"
    cat /tmp/backend.log
fi

echo ""
echo "📱 Starting frontend..."
npm run dev

# Cleanup on exit
trap "kill $BACKEND_PID 2>/dev/null" EXIT