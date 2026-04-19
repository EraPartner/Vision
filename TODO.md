# TODO

## Bugs

### General

### No translations provided for the following

## Features

- Ship the app through docker (marketplace)?
- Add ability to query database using local AI

## Follow-ups

- Env var naming standardization across compose/Electron/backend.
- Electron CSP meta tag audit for renderer.
- Dockerfile frontend-builder prune: revisit dropping `apps/node-backend/package.json` copy once lockfile/workspace install supports it without frozen-lockfile break.
- Build-cancellation in Electron file-watcher rapid triggers (`packaging/electron/main.js:1396-1441`).
- Optional frontend banner consuming `/health/detailed` to surface cache-warming state.
