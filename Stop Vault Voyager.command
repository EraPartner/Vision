#!/bin/bash
# Stop Vision
# Double-click this file in Finder to stop the app.

cd "$(dirname "$0")"

echo "Stopping Vision..."
docker compose down 2>&1

osascript -e 'display notification "Vision has been stopped." with title "Vision"'
