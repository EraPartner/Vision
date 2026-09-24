#!/usr/bin/env python3
"""Fail closed on mutable Actions or checkout credentials in trusted workflows."""

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
USE = re.compile(r"^\s*(?:-\s*)?uses:\s+(\S+)")
PINNED = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def check_workflow(text: str, name: str) -> list[str]:
    errors = []
    lines = text.splitlines()
    for number, line in enumerate(lines):
        match = USE.match(line)
        if not match:
            continue
        action = match.group(1)
        if not action.startswith("./") and not PINNED.fullmatch(action):
            errors.append(f"{name}:{number + 1}: external action needs a full SHA pin")
        if not action.startswith("actions/checkout@"):
            continue
        step_indent = len(line) - len(line.lstrip())
        if not line.lstrip().startswith("- "):
            step_indent -= 2
        following = []
        for candidate in lines[number + 1 :]:
            indent = len(candidate) - len(candidate.lstrip())
            if candidate.lstrip().startswith("- ") and indent <= step_indent:
                break
            following.append(candidate)
        uses_indent = line.index("uses:")
        with_line = " " * uses_indent + "with:"
        setting = re.compile(
            r"^" + " " * (uses_indent + 2) + r"persist-credentials:\s*false\s*(?:#.*)?$"
        )
        has_setting = False
        for index, candidate in enumerate(following):
            if candidate != with_line:
                continue
            for attribute in following[index + 1 :]:
                if (
                    attribute.strip()
                    and len(attribute) - len(attribute.lstrip()) <= uses_indent
                ):
                    break
                if setting.fullmatch(attribute):
                    has_setting = True
            break
        if not has_setting:
            errors.append(
                f"{name}:{number + 1}: checkout must disable persisted credentials"
            )
        repository = re.search(
            r"^\s+repository:\s+([^\s#]+)", "\n".join(following), re.M
        )
        if repository:
            revision = re.search(r"^\s+ref:\s+([^\s#]+)", "\n".join(following), re.M)
            if not revision or not re.fullmatch(r"[0-9a-f]{40}", revision.group(1)):
                errors.append(
                    f"{name}:{number + 1}: external repository checkout needs a full SHA ref"
                )
    if re.search(r"\bbunx\b", text):
        errors.append(f"{name}: dynamic bunx fallback is forbidden in trusted jobs")
    return errors


def discover_actions(root: Path) -> list[Path]:
    workflows = root / ".github/workflows"
    actions = root / ".github/actions"
    return sorted(
        [
            *workflows.glob("*.yml"),
            *workflows.glob("*.yaml"),
            *actions.glob("*/action.yml"),
            *actions.glob("*/action.yaml"),
        ]
    )


def main() -> int:
    errors = []
    paths = discover_actions(ROOT)
    for path in paths:
        errors.extend(check_workflow(path.read_text(), str(path.relative_to(ROOT))))
    setup = (ROOT / ".github/actions/setup/action.yml").read_text()
    if "bun install --frozen-lockfile --ignore-scripts" not in setup:
        errors.append(
            ".github/actions/setup/action.yml: install must be frozen and script-disabled"
        )
    release = (ROOT / ".github/workflows/release.yml").read_text()
    if "actions/cache@" in release or "cache: npm" in release:
        errors.append(
            ".github/workflows/release.yml: release build must not restore a general dependency cache"
        )
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Trusted workflow admission OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
