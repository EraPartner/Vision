#!/bin/bash

echo "🚀 Starting Finance Tracker..."
echo ""

# Start Node.js backend API
echo "📦 Starting Node.js backend API..."
cd apps/node-backend

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Node.js backend dependencies..."
    npm install
fi

echo "✓ Starting Express server on http://localhost:3002"
node src/main.js > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
cd ../..

# Wait for backend to start
echo "Waiting for backend to be ready..."
sleep 2

# Check if backend is running
if curl -s http://localhost:3002/health > /dev/null 2>&1; then
    echo "✓ Backend API is running"
else
    echo "⚠ Backend may not have started correctly. Check /tmp/backend.log"
    cat /tmp/backend.log
fi

echo ""
echo "📱 Starting frontend..."
npm run dev -- --config config/vite.config.ts

# Cleanup on exit
trap "kill $BACKEND_PID 2>/dev/null" EXIT
