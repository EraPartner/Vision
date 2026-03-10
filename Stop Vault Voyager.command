#!/bin/bash
# Stop Vault Voyager
# Double-click this file in Finder to stop the app.

cd "$(dirname "$0")"

echo "Stopping Vault Voyager..."
docker compose down 2>&1

osascript -e 'display notification "Vault Voyager has been stopped." with title "Vault Voyager"'
