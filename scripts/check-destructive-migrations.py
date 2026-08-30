#!/usr/bin/env python3
"""Flags destructive DDL in auto-applied Alembic migrations that carries no explicit marker.

Why this exists
---------------
Native and Docker backend startup run Vision's guarded migration runner before accepting requests,
so anything landing in `alembic/versions/` reaches every installation on its next start -- before,
or without, the app code that depends on the change. That already broke production once:
`0055_drop_bank_account_string` dropped columns + a trigger + a matview ahead of its coupled code
and crashed startup; `0055` is now a no-op and `0056` is its recovery (doctrine in ADR-088). The
fix at the time was a docstring and a convention -- nothing stopped a recurrence.

This is that stop. Destructive DDL inside `upgrade()` must carry a marker:

    # destructive-ok: <reason, citing an ADR / runbook / migration this is safe against>

The marker is deliberately cheap to write and impossible to add by accident. It is not a rubber
stamp -- it is the moment a human is forced to answer "does the code that stops reading this ship
BEFORE this migration auto-applies?". If the answer is no, the change belongs in
`alembic/manual/` (out-of-band, run by hand in lockstep with the code), not in the chain.

Scope and honesty of the pattern set
------------------------------------
Flagged (data loss, or a rewrite the running app can trip over):
  * `op.drop_table(...)`   / raw `DROP TABLE`            -- always; recreating it still loses rows
  * `op.drop_column(...)`  / raw `DROP COLUMN`           -- always
  * raw `DROP MATERIALIZED VIEW` / `VIEW` / `TRIGGER` / `FUNCTION` / `TYPE` / `SCHEMA`
        -- unless the same `upgrade()` recreates an object of that name (the ubiquitous
           DROP-then-CREATE "replace" idiom is not destruction, and flagging it would make the
           marker meaningless through sheer noise)
  * `op.alter_column(..., type_=...)` / raw `ALTER COLUMN ... TYPE`
        -- ALWAYS, marked or not narrowing. Deciding statically whether NUMERIC(12,2) -> NUMERIC(8,2)
           truncates is not possible here, so every type change is made to state its case. Cheap,
           and honest about what static analysis can actually know.

Deliberately NOT flagged:
  * `DROP INDEX` / `op.drop_index`           -- rebuildable, holds no data
  * `DROP CONSTRAINT` / `op.drop_constraint` -- loosens the schema, destroys nothing
  * `DROP DEFAULT` / `DROP NOT NULL`         -- same
  * everything inside `downgrade()`          -- the rollback path is destructive BY DEFINITION;
                                                requiring a marker there flags all 82 migrations
                                                and teaches everyone to ignore the checker
  * `alembic/legacy_versions/` and `alembic/manual/` -- neither is in `version_locations`, so
    neither auto-applies. `alembic/manual/` is precisely where a gated destructive change is
    SUPPOSED to live; flagging it would punish the correct answer.

Usage
-----
    python3 scripts/check-destructive-migrations.py        # scan the chain; exit 1 on findings
    python3 scripts/check-destructive-migrations.py --self-test
    python3 scripts/check-destructive-migrations.py --list  # inventory, always exit 0
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

TAG = "[check-destructive-migrations]"

REPO_ROOT = Path(__file__).resolve().parent.parent
VERSIONS_DIR = REPO_ROOT / "alembic" / "versions"

# The marker, in either comment syntax: `#` for Python, `--` for SQL inside an op.execute() string.
MARKER_RE = re.compile(r"(?:#|--)\s*destructive-ok\s*:\s*(?P<reason>.+?)\s*$")
MIN_REASON_LEN = 10

# How many physical lines above a finding are searched for its marker. Wide enough that a marker
# above an `op.execute("""` opener still covers the SQL inside it; narrow enough that one marker
# at the top of a file cannot launder an unrelated drop 40 lines further down.
MARKER_LOOKBACK = 10

# ── Raw-SQL patterns ─────────────────────────────────────────────────────────────────────────
# `always`: destructive no matter what else the migration does.
SQL_ALWAYS = [
    ("DROP TABLE", re.compile(r"\bDROP\s+TABLE\b", re.I)),
    ("DROP COLUMN", re.compile(r"\bDROP\s+COLUMN\b", re.I)),
    ("DROP SCHEMA", re.compile(r"\bDROP\s+SCHEMA\b", re.I)),
    ("DROP DATABASE", re.compile(r"\bDROP\s+DATABASE\b", re.I)),
    # `SET DATA TYPE` is the spelled-out form; both rewrite the column.
    (
        "ALTER COLUMN TYPE",
        re.compile(r"\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b", re.I),
    ),
]

# `replaceable`: a DROP of a derived//code object. Exempt when the same upgrade() recreates
# something of that name -- that is a replace, not a destruction.
SQL_REPLACEABLE = [
    (
        "DROP MATERIALIZED VIEW",
        re.compile(
            r"\bDROP\s+MATERIALIZED\s+VIEW\b(?:\s+IF\s+EXISTS)?\s+(?P<name>[\w.\"]+)",
            re.I,
        ),
    ),
    (
        "DROP VIEW",
        re.compile(r"\bDROP\s+VIEW\b(?:\s+IF\s+EXISTS)?\s+(?P<name>[\w.\"]+)", re.I),
    ),
    (
        "DROP TRIGGER",
        re.compile(r"\bDROP\s+TRIGGER\b(?:\s+IF\s+EXISTS)?\s+(?P<name>[\w.\"]+)", re.I),
    ),
    (
        "DROP FUNCTION",
        re.compile(
            r"\bDROP\s+FUNCTION\b(?:\s+IF\s+EXISTS)?\s+(?P<name>[\w.\"(]+)", re.I
        ),
    ),
    (
        "DROP TYPE",
        re.compile(r"\bDROP\s+TYPE\b(?:\s+IF\s+EXISTS)?\s+(?P<name>[\w.\"]+)", re.I),
    ),
]

# Any CREATE of a named object, used to detect the DROP-then-CREATE replace idiom.
CREATE_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?"
    r"(?:VIEW|TRIGGER|FUNCTION|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>[\w.\"(]+)",
    re.I,
)

# `op.*` operations. alter_column is conditional on a `type_=` keyword being present.
OP_DESTRUCTIVE = {"drop_table": "op.drop_table", "drop_column": "op.drop_column"}


class Finding:
    __slots__ = ("path", "line", "kind", "detail")

    def __init__(self, path: Path, line: int, kind: str, detail: str) -> None:
        self.path, self.line, self.kind, self.detail = path, line, kind, detail

    def rel(self) -> str:
        try:
            return str(self.path.relative_to(REPO_ROOT))
        except ValueError:
            return str(self.path)


def _normalize_object_name(raw: str) -> str:
    """`"public".Mv_Bank_Balances(` -> `mv_bank_balances`."""
    name = raw.strip().strip(";").replace('"', "")
    name = name.split("(", 1)[0]
    name = name.rsplit(".", 1)[-1]
    return name.lower()


def _has_marker(lines: list[str], line_no: int) -> bool:
    """True if a well-formed marker sits on `line_no` (1-based) or within the lookback above it."""
    start = max(0, line_no - 1 - MARKER_LOOKBACK)
    for text in lines[start:line_no]:
        m = MARKER_RE.search(text)
        if m and len(m.group("reason").strip()) >= MIN_REASON_LEN:
            return True
    return False


def _exempt_lines(tree: ast.Module) -> set[int]:
    """Line numbers that are NOT checked: the `downgrade()` body.

    The rollback path is destructive by definition, so requiring a marker there would flag most of
    the chain and teach everyone to ignore the checker. Everything else in the module IS checked,
    including module-level code and helper functions -- a helper called from `upgrade()`
    auto-applies exactly like inline code, so exempting helpers by name would be a trivial bypass.
    """
    exempt: set[int] = set()
    for node in tree.body:
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "downgrade"
        ):
            exempt.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    return exempt


def scan_file(path: Path) -> list[Finding]:
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    try:
        tree = ast.parse(source, filename=str(path))
    except (
        SyntaxError
    ) as exc:  # a migration that cannot be parsed cannot be vouched for
        return [
            Finding(path, exc.lineno or 1, "unparseable", f"could not parse: {exc.msg}")
        ]

    exempt = _exempt_lines(tree)

    def checked(line_no: int) -> bool:
        return line_no not in exempt

    findings: list[Finding] = []

    # ── 1. op.* calls (AST: exact, and immune to line wrapping) ──────────────────────────────
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        # `op.drop_column(...)` and `batch_op.drop_column(...)` (SQLite batch mode, which
        # alembic/env.py enables) are Attribute calls; a bare `drop_column(...)` from an
        # `from alembic.op import ...` is a Name call. Both count.
        if isinstance(node.func, ast.Attribute):
            attr = node.func.attr
        elif isinstance(node.func, ast.Name):
            attr = node.func.id
        else:
            continue
        if not checked(node.lineno):
            continue
        if attr in OP_DESTRUCTIVE:
            findings.append(
                Finding(
                    path,
                    node.lineno,
                    OP_DESTRUCTIVE[attr],
                    f"{OP_DESTRUCTIVE[attr]}(...)",
                )
            )
        elif attr == "alter_column" and any(kw.arg == "type_" for kw in node.keywords):
            findings.append(
                Finding(
                    path,
                    node.lineno,
                    "op.alter_column type change",
                    "op.alter_column(..., type_=...) -- may narrow/rewrite the column",
                )
            )

    # ── 2. Raw SQL, restricted to lines that are part of a string literal ────────────────────
    # Collecting literal line ranges from the AST (rather than regexing the whole file) means a
    # Python comment or docstring that merely MENTIONS "DROP TABLE" is never flagged.
    # JoinedStr (f-string) is listed alongside Constant so interpolated DDL --
    # `f"DROP TABLE {name}"` -- is covered on every Python version, not just the ones where the
    # inner literal chunks carry accurate line numbers.
    sql_line_nos: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr) or (
            isinstance(node, ast.Constant) and isinstance(node.value, str)
        ):
            sql_line_nos.update(
                range(node.lineno, (node.end_lineno or node.lineno) + 1)
            )
    docstring_lines: set[int] = set()
    for scope in [tree] + [
        n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef))
    ]:
        body = getattr(scope, "body", None)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
        ):
            if isinstance(body[0].value.value, str):
                first = body[0].value
                docstring_lines.update(
                    range(first.lineno, (first.end_lineno or first.lineno) + 1)
                )
    sql_line_nos -= docstring_lines

    created = {
        _normalize_object_name(m.group("name"))
        for line_no in sorted(sql_line_nos)
        if checked(line_no)
        for m in CREATE_RE.finditer(lines[line_no - 1])
    }

    for line_no in sorted(sql_line_nos):
        if not checked(line_no):
            continue
        text = lines[line_no - 1]
        for label, pattern in SQL_ALWAYS:
            if pattern.search(text):
                findings.append(
                    Finding(path, line_no, label, f"raw SQL: {text.strip()[:100]}")
                )
        for label, pattern in SQL_REPLACEABLE:
            m = pattern.search(text)
            if not m:
                continue
            if _normalize_object_name(m.group("name")) in created:
                continue  # DROP-then-CREATE of the same object == replace, not destruction
            findings.append(
                Finding(path, line_no, label, f"raw SQL: {text.strip()[:100]}")
            )

    return [f for f in findings if not _has_marker(lines, f.line)]


def all_findings(directory: Path) -> tuple[list[Finding], int]:
    files = sorted(p for p in directory.glob("*.py") if p.name != "__init__.py")
    findings: list[Finding] = []
    for path in files:
        findings.extend(scan_file(path))
    findings.sort(key=lambda f: (f.rel(), f.line))
    return findings, len(files)


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

_SELF_TEST_HEADER = (
    '"""Fixture migration."""\n\nfrom alembic import op\nimport sqlalchemy as sa\n\n'
)

SELF_TEST_CASES: list[tuple[str, str, int]] = [
    (
        "unmarked op.drop_column is caught",
        'def upgrade() -> None:\n    op.drop_column("transactions", "bank_account")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "marked op.drop_column passes",
        "def upgrade() -> None:\n    # destructive-ok: readers flipped to account_id in 0051 (ADR-088)\n"
        '    op.drop_column("transactions", "bank_account")\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "a marker with a throwaway reason does not count",
        'def upgrade() -> None:\n    # destructive-ok: ok\n    op.drop_column("t", "c")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "unmarked op.drop_table is caught",
        'def upgrade() -> None:\n    op.drop_table("custom_raw_transactions")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "destructive DDL in downgrade() is exempt",
        'def upgrade() -> None:\n    pass\n\n\ndef downgrade() -> None:\n    op.drop_table("t")\n    op.drop_column("t", "c")\n    op.execute("DROP TABLE other")\n',
        0,
    ),
    (
        "raw SQL DROP TABLE is caught",
        'def upgrade() -> None:\n    op.execute("""\n        DROP TABLE mv_stale;\n    """)\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "a marker above the op.execute() opener covers the SQL inside it",
        'def upgrade() -> None:\n    # destructive-ok: dead view, zero readers -- see ADR-088 addendum\n    op.execute("""\n        DROP MATERIALIZED VIEW IF EXISTS mv_bank_balances;\n    """)\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "an SQL-comment marker inside the string also counts",
        'def upgrade() -> None:\n    op.execute("""\n        -- destructive-ok: superseded by accounts (ADR-088)\n        DROP TABLE legacy_banks;\n    """)\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "DROP-then-CREATE of the same trigger is a replace, not a destruction",
        'def upgrade() -> None:\n    op.execute("""\n        DROP TRIGGER IF EXISTS trg_sync ON transactions;\n        CREATE TRIGGER trg_sync BEFORE INSERT ON transactions\n            FOR EACH ROW EXECUTE FUNCTION sync_account_id();\n    """)\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "dropping a trigger WITHOUT recreating it is caught (the 0055 shape)",
        'def upgrade() -> None:\n    op.execute("""\n        DROP TRIGGER IF EXISTS trg_sync ON transactions;\n    """)\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "unmarked op.alter_column with a type change is caught",
        'def upgrade() -> None:\n    op.alter_column("t", "amount", type_=sa.Numeric(8, 2), existing_type=sa.Numeric(18, 2))\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "op.alter_column without a type change is not destructive",
        'def upgrade() -> None:\n    op.alter_column("t", "recipient_id", nullable=True)\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "raw ALTER COLUMN ... TYPE is caught",
        'def upgrade() -> None:\n    op.execute("ALTER TABLE t ALTER COLUMN amount TYPE NUMERIC(8,2)")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "DROP INDEX / DROP CONSTRAINT are not treated as destructive",
        'def upgrade() -> None:\n    op.drop_index("idx_t_date", table_name="t")\n    op.drop_constraint("uq_accounts_name", "accounts", type_="unique")\n    op.execute("DROP INDEX IF EXISTS idx_other; ALTER TABLE t ALTER COLUMN c DROP NOT NULL;")\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "a docstring merely mentioning DROP TABLE is not a finding",
        'def upgrade() -> None:\n    """This migration used to DROP TABLE transactions; it no longer does."""\n    pass\n\n\ndef downgrade() -> None:\n    pass\n',
        0,
    ),
    (
        "a marker cannot launder a drop far below it",
        "def upgrade() -> None:\n    # destructive-ok: this reason belongs to the statement right below it\n"
        '    op.drop_column("t", "a")\n'
        + "".join(f"    op.execute('SELECT {i}')\n" for i in range(12))
        + '    op.drop_column("t", "b")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "a helper function called from upgrade() is checked too",
        'def _do_drop() -> None:\n    op.drop_table("t")\n\n\ndef upgrade() -> None:\n    _do_drop()\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "batch_op.drop_column (SQLite batch mode) is caught",
        'def upgrade() -> None:\n    with op.batch_alter_table("t") as batch_op:\n        batch_op.drop_column("c")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
    (
        "an f-string interpolating a DROP TABLE is caught",
        'def upgrade() -> None:\n    for name in ("a", "b"):\n        op.execute(f"DROP TABLE IF EXISTS {name}_raw")\n\n\ndef downgrade() -> None:\n    pass\n',
        1,
    ),
]


def run_self_test() -> int:
    import tempfile

    passed = failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (name, body, expected) in enumerate(SELF_TEST_CASES):
            path = Path(tmp) / f"case_{i:03d}.py"
            path.write_text(_SELF_TEST_HEADER + body, encoding="utf-8")
            got = len(scan_file(path))
            if got == expected:
                passed += 1
                print(f"{TAG}   ok   {name}")
            else:
                failed += 1
                print(f"{TAG}   FAIL {name}: expected {expected} finding(s), got {got}")
                for f in scan_file(path):
                    print(f"{TAG}          line {f.line}: {f.kind} -- {f.detail}")

    print(f"{TAG} self-test: {passed} passed, {failed} failed.")
    return 1 if failed else 0


# ── Entry point ──────────────────────────────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()

    if not VERSIONS_DIR.is_dir():
        print(
            f"{TAG} ERROR: {VERSIONS_DIR} not found (run from anywhere in the repo).",
            file=sys.stderr,
        )
        return 1

    findings, file_count = all_findings(VERSIONS_DIR)

    if "--list" in argv:
        for f in findings:
            print(f"{f.rel()}:{f.line}: {f.kind} -- {f.detail}")
        print(
            f"{TAG} {len(findings)} unmarked finding(s) across {file_count} migration(s)."
        )
        return 0

    if findings:
        print(
            f"{TAG} ERROR: destructive DDL without a `destructive-ok:` marker:",
            file=sys.stderr,
        )
        print("", file=sys.stderr)
        for f in findings:
            print(f"  {f.rel()}:{f.line}", file=sys.stderr)
            print(f"      {f.kind}: {f.detail}", file=sys.stderr)
        print(
            "\n"
            "  Every file in alembic/versions/ is applied by the guarded migration runner on the\n"
            "  next application boot, whether or not the code that\n"
            "  depends on it has shipped. That is how 0055 crashed startup (ADR-088).\n"
            "\n"
            "  Either:\n"
            "    1. Move the change out of the auto-applied chain, into alembic/manual/<name>/\n"
            "       (up.sql + down.sql + README), to be run by hand in lockstep with the code.\n"
            "       This is the right answer whenever running code still reads what you drop.\n"
            "    2. Or, if the coupled code already shipped and the drop is genuinely safe on an\n"
            "       unattended boot, state why on the line(s) above the statement:\n"
            "\n"
            "           # destructive-ok: <reason, citing an ADR / runbook / prior migration>\n"
            "\n"
            "  See docs/guides/migrations.md -> 'Destructive DDL and the destructive-ok marker'.",
            file=sys.stderr,
        )
        return 1

    print(f"{TAG} OK: {file_count} migration(s) scanned, no unmarked destructive DDL.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
