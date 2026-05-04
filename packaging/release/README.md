# Vision __VERSION__ — macOS

Vision is a self-hosted financial transaction manager. Everything runs on
your machine — your data never leaves your computer.

The `Vision.app` is an Electron shell that starts and supervises a small
Docker container stack (Postgres + the Vision backend). You run one app,
not three.

## What's in this release

| File | Purpose |
|---|---|
| `Vision-__VERSION__-arm64.dmg` | The application installer (Apple Silicon) |
| `Vision-__VERSION__-arm64-mac.zip` | Same app as a zip; alternative to the DMG |
| `vision-setup.command` | One-time dependency installer (run before first launch) |
| `README.md` | This file |
| `*.sha256` | Checksums for each artifact above |

## Requirements

- macOS 12 (Monterey) or newer
- Apple Silicon (M1 / M2 / M3 / M4)
- ~5 GB free disk space — Docker Desktop ~3 GB, Vision image ~1 GB, the
  database grows with your data
- Internet connection on **first** launch only

## First-time install (~5–10 min)

### 1. Verify the downloads (optional but recommended)

```sh
shasum -a 256 -c Vision-__VERSION__-arm64.dmg.sha256
shasum -a 256 -c vision-setup.command.sha256
```

Each line should end with `OK`.

### 2. Run the setup script

The script installs Docker Desktop if you don't have it and pre-downloads
the Vision container image. The Vision app itself does not download
hundreds of megabytes on first launch — this script does, while you can
see progress in a Terminal window.

In Finder:

1. Right-click `vision-setup.command` → **Open** → **Open**.
   (Required because the script is unsigned. Only needed the first time.)
2. A Terminal window opens and runs the script. It will:
   - Install Docker Desktop if missing
   - Start Docker
   - Pull the Vision container image
3. Wait for `Setup complete.` (5–10 min on a normal connection).

If you prefer the command line:

```sh
bash ~/Downloads/vision-setup.command
```

### 3. Install the app

1. Double-click `Vision-__VERSION__-arm64.dmg`.
2. Drag `Vision.app` to the `Applications` folder.
3. Eject the DMG (drag it to the Trash).

### 4. First launch

Right-click `Vision.app` in `/Applications` → **Open** → **Open**.

> macOS shows **"Vision.app cannot be opened because the developer cannot
> be verified."** because the build is signed with an ad-hoc signature
> (free) rather than an Apple Developer ID (paid). The right-click → Open
> bypass is only needed on the **first** launch. After that, double-click
> works like any other app.

The first launch does:

1. Starts the Postgres + backend containers
2. Waits for them to become healthy
3. Loads the UI in the Electron window

First launch: 10 – 30 seconds. Subsequent launches: 5 – 10 seconds.

## Daily use

Double-click `Vision.app`. That's it.

When you quit Vision, the Docker containers keep running in the
background so the next launch is instant. To stop them, open Docker
Desktop and stop the `vision` project (or quit Docker Desktop).

## Updating

1. Download the new release's `.dmg` and `vision-setup.command`.
2. Re-run `vision-setup.command` (it pulls the new image version).
3. Drag the new `Vision.app` over `/Applications/Vision.app`. Finder will
   ask to replace.
4. Open the app.

Your settings, attachments, and database are preserved across updates.

## Where your data lives

| Location | Contents |
|---|---|
| `~/Library/Application Support/Vision/` | Settings, embedded `docker-compose.yml`, logs |
| Docker volume `vision_postgres_data` | The Postgres database (transactions, accounts, …) |
| Docker volume `vision_vision_cache_data` | Backend cache; safe to delete |

## Backup & restore

Use the in-app **Backup → Export** menu. It writes a `.visionbak` file
containing the database and your attachments. Importing on a fresh
install restores everything.

For an offline backup of just the database:

```sh
docker compose -p vision exec db pg_dump -U ftm_user financial_transactions \
  > vision-$(date +%F).sql
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| **"Vision.app is damaged and can't be opened"** | In Terminal: `xattr -cr /Applications/Vision.app` then try again. Or right-click → Open → Open. |
| **App hangs on "Starting Docker…"** | Open Docker Desktop, wait for the whale icon to turn green, then quit and reopen Vision. |
| **"Image pull failed" on first launch** | Check internet, then re-run `vision-setup.command`. |
| **Window opens blank, no UI** | Quit Vision. In Terminal: `docker compose -p vision -f "$HOME/Library/Application Support/Vision/embedded_compose/docker-compose.yml" logs --tail=200 app` and read the last error. |
| **Reset everything** | Quit the app, then: `rm -rf "$HOME/Library/Application Support/Vision"; docker compose -p vision down -v` |
| **"vision-setup.command" can't be opened** | Right-click → Open → Open (Gatekeeper). Or `bash vision-setup.command`. |

## Uninstall

```sh
rm -rf /Applications/Vision.app
rm -rf "$HOME/Library/Application Support/Vision"
docker compose -p vision down -v
docker rmi ghcr.io/erapartner/vision:__VERSION__
```

You can additionally remove Docker Desktop if you don't use it for
anything else: drag `/Applications/Docker.app` to the Trash.

## Why is the app unsigned?

Apple's Developer ID program costs $99/year. Until that is in place, the
app uses an **ad-hoc** signature — enough for macOS to load the binary,
not enough for Gatekeeper to trust it without a one-time
right-click → Open. There is no security difference once you have run the
app once and accepted it.

## Source code & issues

https://github.com/EraPartner/Vision
