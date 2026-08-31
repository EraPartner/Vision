#!/usr/bin/env python3
"""Assert that the auto-applied Alembic chain has exactly one head."""

from __future__ import annotations

import ast
from pathlib import Path
import sys
import tempfile


TAG = "[check-alembic-heads]"
VERSIONS_DIR = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def literal_assignment(tree: ast.Module, name: str) -> object:
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if any(
            isinstance(target, ast.Name) and target.id == name for target in targets
        ):
            return ast.literal_eval(node.value)
    raise ValueError(f"missing {name!r} assignment")


def find_heads(versions_dir: Path) -> tuple[set[str], int]:
    revisions: set[str] = set()
    parents: set[str] = set()
    files = sorted(versions_dir.glob("*.py"))
    if not files:
        raise ValueError(f"no migrations found under {versions_dir}")

    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        revision = literal_assignment(tree, "revision")
        down_revision = literal_assignment(tree, "down_revision")
        if not isinstance(revision, str) or not revision:
            raise ValueError(f"{path.name}: revision must be a non-empty string")
        if revision in revisions:
            raise ValueError(f"{path.name}: duplicate revision {revision!r}")
        revisions.add(revision)
        if isinstance(down_revision, str):
            parents.add(down_revision)
        elif isinstance(down_revision, (tuple, list)):
            if not all(isinstance(parent, str) for parent in down_revision):
                raise ValueError(f"{path.name}: down_revision contains a non-string")
            parents.update(down_revision)
        elif down_revision is not None:
            raise ValueError(f"{path.name}: unsupported down_revision value")

    unknown = parents - revisions
    if unknown:
        raise ValueError(f"unknown parent revision(s): {', '.join(sorted(unknown))}")
    return revisions - parents, len(files)


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "a.py").write_text(
            "revision = 'a'\ndown_revision = None\n", encoding="utf-8"
        )
        (root / "b.py").write_text(
            "revision = 'b'\ndown_revision = 'a'\n", encoding="utf-8"
        )
        assert find_heads(root)[0] == {"b"}
        (root / "c.py").write_text(
            "revision = 'c'\ndown_revision = 'a'\n", encoding="utf-8"
        )
        assert find_heads(root)[0] == {"b", "c"}
    print(f"{TAG} self-test passed")


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:]:
        print(f"{TAG} usage: check-alembic-heads.py [--self-test]", file=sys.stderr)
        return 2
    try:
        heads, file_count = find_heads(VERSIONS_DIR)
    except (OSError, SyntaxError, ValueError) as error:
        print(f"{TAG} ERROR: {error}", file=sys.stderr)
        return 1
    if len(heads) != 1:
        print(
            f"{TAG} ERROR: expected exactly one head, found {len(heads)}: "
            f"{', '.join(sorted(heads))}",
            file=sys.stderr,
        )
        return 1
    print(f"{TAG} OK: {file_count} migrations, head {next(iter(heads))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
