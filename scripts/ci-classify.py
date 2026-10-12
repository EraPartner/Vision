#!/usr/bin/env python3
"""Fail closed when deciding whether the application CI may be skipped."""

import os
import subprocess
from collections.abc import Collection, Sequence

# The Swift app, and the Electron readers the native-interop job runs against its output.
NATIVE_PREFIXES = ("apps/native/", "packaging/electron/backup/")
NATIVE_FILES = frozenset(
    {
        "install-native.sh",
        ".github/workflows/ci.yml",
        "packaging/electron/audit-anchor.ts",
        "packaging/electron/scripts/native-audit-fixture.ts",
        # What the native-interop job installs and compiles the Electron readers with.
        "packaging/electron/build.ts",
        "packaging/electron/package.json",
        "packaging/electron/bun.lock",
        "packaging/electron/tsconfig.base.json",
        "packaging/electron/tsconfig.json",
        "packaging/electron/tsconfig.preload.json",
    }
)


def classify(paths: Sequence[str], special_paths: Collection[str] = ()) -> bool:
    if not paths:
        return True
    for path in paths:
        if path in special_paths:
            return True
        if path.startswith(("docs/",)) or ("/" not in path and path.endswith(".md")):
            continue
        # Configuration, executables and unknown formats still run the full suite.
        if path.startswith((".agents/", ".codex/")) and path.endswith(".md"):
            continue
        return True
    return False


def classify_native(paths: Sequence[str]) -> bool:
    """Decide whether the macOS Vision Native job must run (ADR-204)."""
    if not paths:
        return True
    return any(path.startswith(NATIVE_PREFIXES) or path in NATIVE_FILES for path in paths)


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL)


def changed_paths(base: str, head: str) -> list[str]:
    if not base or not head or base == "0" * 40:
        raise ValueError("commit range is not resolvable")
    git("cat-file", "-e", base + "^{commit}")
    git("cat-file", "-e", head + "^{commit}")
    # Disable rename detection so both sides of a move are classified.
    return (
        git("diff", "--name-only", "--no-renames", "-z", base, head)
        .decode()
        .split("\0")[:-1]
    )


def classify_range(base: str, head: str) -> bool:
    try:
        paths = changed_paths(base, head)
        special: set[str] = set()
        for ref in (base, head):
            for entry in git("ls-tree", "-rz", ref).decode().split("\0"):
                if entry:
                    metadata, path = entry.split("\t", 1)
                    if metadata.split()[0] != "100644":
                        special.add(path)
        return classify(paths, special)
    except (subprocess.CalledProcessError, UnicodeError, ValueError):
        return True


def classify_native_range(base: str, head: str) -> bool:
    try:
        return classify_native(changed_paths(base, head))
    except (subprocess.CalledProcessError, UnicodeError, ValueError):
        return True


def classify_event(event_name: str, base: str, head: str) -> tuple[bool, bool]:
    """Return (code, native). Pushes always run the native job."""
    code = classify_range(base, head)
    native = classify_native_range(base, head) if event_name == "pull_request" else True
    return code, native


if __name__ == "__main__":
    event_name = os.environ.get("EVENT_NAME", "")
    is_pr = event_name == "pull_request"
    base = os.environ.get("PR_BASE_SHA" if is_pr else "PUSH_BEFORE", "")
    head = os.environ.get("PR_HEAD_SHA" if is_pr else "PUSH_SHA", "")
    code, native = classify_event(event_name, base, head)
    print(
        "Full application pipeline."
        if code
        else "Documentation/instruction diff; focused checks remain required."
    )
    print("Vision Native job required." if native else "Vision Native unchanged.")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write("code=" + str(code).lower() + "\n")
        output.write("native=" + str(native).lower() + "\n")
