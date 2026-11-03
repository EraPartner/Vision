---
title: Moving Vision 2.0 Data to SQLite
type: guide
status: active
date: 2026-11-03
updated: 2026-11-03
tags: [guide, database, sqlite, transition, backup, checklist]
description: The safe-transition checklist for moving a Vision 2.0 (PostgreSQL) installation to the SQLite database with the one-time transition script
aliases: [sqlite-transition, transition-checklist, vision-2-to-sqlite]
related_code:
  [
    "scripts/vision-v2-to-sqlite.ts",
    "apps/node-backend/scripts/transition/",
    "apps/node-backend/tests/transition/",
    "packaging/electron/runtime/native.ts",
  ]
---

# Moving Vision 2.0 data to SQLite

Vision 2.0 kept its data in a private PostgreSQL server. Later versions keep it in one SQLite file
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). The data moves once, through a Vision 2.0
backup and a script you run in a terminal. The app itself never converts anything.

> [!important] What protects your data
> - The script only reads the backup. It never contacts, starts or changes PostgreSQL, and it
>   never touches the Vision 2.0 data folder.
> - Nothing is installed unless every check passes, and an existing database is never
>   overwritten.
> - The new Vision refuses to start while it finds Vision 2.0 data and no SQLite database, so it
>   cannot start empty over your data.

## Checklist

### Before you install the new version (in Vision 2.0)

1. **Make a fresh backup.** Settings > Backup > **Back up now**. Note the file it writes in your
   backup folder: `vision_backup_<device>_<time>.visionbak`, or `.visionbak.enc` when encryption
   is on. If encryption is on, have the passphrase ready.
2. **Write down a few figures** to compare afterwards: the balance of each account, net worth and
   the portfolio value. A screenshot of each page is enough.
3. **Quit Vision 2.0.**

### Install and convert

4. **Install the new Vision** and open it once. It stops with "Vision found data from Vision 2.0
   on this Mac and did not start". That is expected: quit it.
5. **Update the repository checkout** to the release (`git pull`, then `bun install`).
6. **Run the script once** from the checkout, with the backup from step 1:

   ```bash
   bun run transition:v2 -- ~/path/to/vision_backup_<device>_<time>.visionbak.enc
   ```

   It asks for the passphrase of an encrypted backup. It prints its progress, then one line per
   check, and ends with `Report: <path>`. Success says **all checks passed**. On any failure it
   installs nothing, says which table, column, row and value failed, and exits with code 1.
   To look first without installing anything, add `--dry-run`.

### After the conversion

7. **Open Vision.** Compare the figures from step 2. The JSON report also holds the exact count,
   sum, minimum and maximum of every money column, from the backup and from the new database.
8. **Check a saved analysis with custom SQL**, if you have any. Analyses written in SQL for
   PostgreSQL are kept but show "needs review" until you save them again in the SQLite dialect.
   Analyses built in the visual editor need nothing.
9. **Keep what the script left untouched** until you are satisfied:
   - the backup file from step 1;
   - the Vision 2.0 data in `~/Library/Application Support/Vision/native/vision/postgres/data`;
   - the copy of the backup and the report next to the new database, in
     `~/Library/Application Support/Vision/database/`.
   Vision never deletes the Vision 2.0 folder. Delete it yourself once you no longer need it.

## What the script checks

- Row counts and a SHA-256 per table, from the backup and from the new database.
- A second, independent read of the backup that compares every value of every row.
- Count, exact sum, minimum and maximum of every money and decimal column.
- SQLite's `integrity_check` and `foreign_key_check`, the schema against a fresh install, the
  migration ledger, the sequences and the triggers, and the same verification Vision runs before
  every restore.
- Attachment checksums after copying, and the backup's own SHA-256 after the run.

What it cannot check, and says so in the report: that the backup holds your latest data, that the
app shows the same figures (steps 2 and 7), the summary tables Vision rebuilds at start,
`real` columns now stored as doubles, enum ordering now in text order, custom SQL written for
PostgreSQL, and browser preferences after a direct install.

## Other cases

| Situation | What to do |
| --- | --- |
| No Vision 2.0 backup was made before the update | The backup Vision 2.0 made before an in-app update is usually in `~/Library/Application Support/Vision/pre-update-backups/`. Otherwise reinstall Vision 2.0, make a backup, and start again at step 3. |
| Restore on another Mac, or keep the browser preferences | `bun run transition:v2 -- <backup> --to-backup <new.visionbak>` writes a SQLite backup, encrypted when the input was. Restore it in Settings > Backup. |
| The script says the database already exists | It never overwrites one. With the same backup it reports that the transition is already done and changes nothing. To replace the database, restore a backup in Settings > Backup. |
| An older Vision backup must be restored later | Convert it with `--to-backup` first; Vision restores only SQLite backups. |
| Vision's data folder is not the default | Add `--user-data <folder>`. |

Exit codes: `0` success or already done, `1` an input or verification error, `2` a usage error.
`bun run transition:v2 -- --help` lists every option.

## Related

- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]: SQLite replaces PostgreSQL
- [[docs/guides/migrations|Database Migration Guide]]
- [[docs/guides/native-macos-runtime|Native macOS runtime]]
