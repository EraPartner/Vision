# Vision unsigned portable bundle

This folder contains a simple unsigned distribution bundle for Vision. It is
meant for testing and internal distribution only. Unsigned bundles will trigger
macOS Gatekeeper warnings for end users — use at your own risk.

Contents
- `Vision.app` — the application bundle (unsigned)
- `launch.command` — double-clickable launcher that removes quarantine and opens the app

How to use
1. Unzip the downloaded archive.
2. Double-click `launch.command`. It installs `Vision.app` into `/Applications`
   (or `~/Applications` if needed), removes quarantine, and starts the app.
3. If macOS still prevents opening, right-click `Vision.app` in Applications,
   choose `Open`, then confirm once.

Security note
- This bundle is unsigned and not notarized. Only install/run it on machines
  you trust. For public distribution you must sign with a Developer ID and
  notarize the app bundle.
