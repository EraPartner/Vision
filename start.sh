#!/bin/bash

echo "🚀 Starting Finance Tracker..."
echo ""

# Start backend
echo "📦 Starting Python backend..."
cd apps/backend

# Find a compatible Python version (3.10-3.13)
PYTHON_CMD=""
for version in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v $version &> /dev/null; then
        PYTHON_VERSION=$($version --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
        MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
        MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)
        
        # Check if version is 3.10-3.13 (compatible range)
        if [ "$MAJOR" = "3" ] && [ "$MINOR" -ge "10" ] && [ "$MINOR" -le "13" ]; then
            PYTHON_CMD=$version
            echo "✓ Using $version (Python $PYTHON_VERSION)"
            break
        fi
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "❌ Error: Python 3.10-3.13 not found. Python 3.14 is too new for some dependencies."
    echo "Please install Python 3.13 or 3.12:"
    echo "  - macOS: brew install python@3.13"
    echo "  - Ubuntu: sudo apt install python3.13"
    exit 1
fi

# Create/activate virtual environment using bash
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    bash -c "$PYTHON_CMD -m venv venv"
fi

echo "Installing dependencies..."
bash -c "source venv/bin/activate && pip install --upgrade pip > /dev/null 2>&1 && pip install -r requirements.txt > /dev/null 2>&1"

# Start the backend
bash -c "source venv/bin/activate && python main.py" &
BACKEND_PID=$!
cd ../..

# Wait for backend to start
sleep 3

# Start frontend
echo "🎨 Starting React frontend..."
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ Application started!"
echo "📱 Frontend: http://localhost:8080"
echo "🔧 Backend API: http://localhost:8000"
echo "📚 API Docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop all servers"

# Handle Ctrl+C
trap "echo '🛑 Shutting down...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT

wait