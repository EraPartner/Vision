"""Unit checks for Alembic's transactional audit callback.

The hook is loaded without executing env.py's database connection setup.
Disposable PostgreSQL upgrade/downgrade proof remains the db:check gate.
"""

import ast
import hashlib
import importlib.util
import json
import pathlib
import re
import types
import unittest
from unittest import mock

from sqlalchemy import text


ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "alembic" / "env.py"


def load_hook():
    source = ast.parse(SOURCE.read_text())
    names = {"_revision_at_or_after_audit_chain", "_append_migration_audit"}
    selected = [
        node
        for node in source.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    namespace = {
        "hashlib": hashlib,
        "json": json,
        "re": re,
        "text": text,
        "AUDIT_CHAIN_REVISION": "0117_audit_chain",
        "AUDIT_GENESIS_HASH": "0" * 64,
        "MAX_SAFE_INTEGER": 2**53 - 1,
    }
    exec(
        compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"),
        namespace,
    )
    return namespace["_append_migration_audit"]


class Result:
    def __init__(self, value=None, row=None, rowcount=1):
        self.value = value
        self.row = row
        self.rowcount = rowcount

    def scalar_one(self):
        return self.value

    def mappings(self):
        return self

    def one(self):
        if self.row is None:
            raise RuntimeError("missing row")
        return self.row

    def first(self):
        return self.row


class FakeConnection:
    dialect = types.SimpleNamespace(name="postgresql")

    def __init__(self, has_chain=True, fail_insert=False):
        self.has_chain = has_chain
        self.fail_insert = fail_insert
        self.entries = []
        self.sequence = 0
        self.head_hash = "0" * 64

    def execute(self, query, params=None):
        sql = str(query)
        if "to_regclass" in sql:
            return Result(value=self.has_chain)
        if "FROM audit_chain_head" in sql:
            return Result(
                row={"last_sequence": self.sequence, "last_hash": self.head_hash}
            )
        if "FROM audit_chain_entries" in sql:
            return Result(row=self.entries[-1] if self.entries else None)
        if "INSERT INTO audit_chain_entries" in sql:
            if self.fail_insert:
                raise RuntimeError("append failed")
            self.entries.append(
                {
                    "sequence": params["sequence"],
                    "entry_hash": params["entry_hash"],
                    "payload": json.loads(params["payload"]),
                }
            )
            return Result()
        if "UPDATE audit_chain_head" in sql:
            self.sequence = params["sequence"]
            self.head_hash = params["entry_hash"]
            return Result(rowcount=1)
        raise AssertionError(f"Unexpected query: {sql}")


class RevisionMap:
    parents = {
        "0115_research_dossiers": None,
        "0116_analysis_monitors": "0115_research_dossiers",
        "0117_audit_chain": "0116_analysis_monitors",
        "0118_later": "0117_audit_chain",
    }

    def get_revision(self, revision_id):
        if revision_id not in self.parents:
            return None
        return types.SimpleNamespace(down_revision=self.parents[revision_id])


def make_step(revision, *, is_upgrade=True, is_stamp=False):
    return types.SimpleNamespace(
        up_revision_id=revision,
        up_revision_ids=(revision,),
        revision_map=RevisionMap(),
        is_upgrade=is_upgrade,
        is_stamp=is_stamp,
    )


class AuditMigrationHookTests(unittest.TestCase):
    def setUp(self):
        self.hook = load_hook()

    def call(
        self, connection, revision, *, is_upgrade=True, is_stamp=False, heads=None
    ):
        self.hook(
            types.SimpleNamespace(connection=connection),
            make_step(revision, is_upgrade=is_upgrade, is_stamp=is_stamp),
            set(heads or [revision]),
            {},
        )

    def test_0117_entry_matches_node_canonical_hash(self):
        connection = FakeConnection()
        self.call(connection, "0117_audit_chain")
        self.assertEqual(connection.sequence, 1)
        self.assertEqual(
            connection.head_hash,
            "3ba734e0082640c23c8771b1b57525b440136602d25ca20fd5e0798e406e6563",
        )
        self.assertEqual(connection.entries[0]["payload"]["direction"], "upgrade")
        self.call(connection, "0118_later")
        self.assertEqual(connection.sequence, 2)

    def test_pre_chain_skipped_but_missing_post_chain_fails(self):
        connection = FakeConnection(has_chain=False)
        self.call(connection, "0116_analysis_monitors")
        self.assertEqual(connection.entries, [])
        with self.assertRaisesRegex(RuntimeError, "Audit chain is missing"):
            self.call(connection, "0118_later")

    def test_0117_empty_downgrade_can_drop_chain(self):
        self.call(
            FakeConnection(has_chain=False),
            "0117_audit_chain",
            is_upgrade=False,
            heads=["0116_analysis_monitors"],
        )

    def test_stamp_records_version_change_when_chain_exists(self):
        connection = FakeConnection()
        self.call(connection, "0118_later", is_stamp=True)
        self.assertEqual(connection.entries[0]["payload"]["event"], "version_changed")
        self.assertEqual(connection.entries[0]["payload"]["direction"], "stamp")

    def test_append_failure_propagates_to_alembic(self):
        connection = FakeConnection(fail_insert=True)
        with self.assertRaisesRegex(RuntimeError, "append failed"):
            self.call(connection, "0117_audit_chain")
        self.assertEqual(connection.sequence, 0)

    def test_0117_downgrade_requires_exact_unanchored_upgrade_entry(self):
        migration_path = ROOT / "alembic" / "versions" / "0117_audit_chain.py"
        spec = importlib.util.spec_from_file_location(
            "audit_migration_0117", migration_path
        )
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        with mock.patch.object(migration.op, "execute") as execute:
            migration.downgrade()
        sql = execute.call_args.args[0]
        guard, drops = sql.split("END $$;", 1)
        self.assertLess(
            guard.index("LOCK TABLE db_editor_audit"),
            guard.index("LOCK TABLE audit_chain_head"),
        )
        self.assertLess(
            guard.index("LOCK TABLE audit_chain_head"), guard.index("DO $$ BEGIN")
        )
        self.assertIn("COUNT(*) FROM audit_chain_entries) <> 1", guard)
        self.assertIn("EXISTS (SELECT 1 FROM audit_chain_checkpoints)", guard)
        self.assertIn("sequence = 1", guard)
        self.assertIn("version = 1", guard)
        self.assertIn("previous_hash = repeat('0', 64)", guard)
        self.assertIn(
            "3ba734e0082640c23c8771b1b57525b440136602d25ca20fd5e0798e406e6563", guard
        )
        self.assertIn('"stream":"schema_migration"', guard)
        self.assertIn("last_sequence = 1", guard)
        self.assertIn("legacy_db_editor_max_id", guard)
        self.assertIn("legacy_split_max_id", guard)
        self.assertIn("legacy_retag_max_id", guard)
        self.assertIn("RAISE EXCEPTION", guard)
        self.assertIn("DROP TABLE audit_chain_entries", drops)


if __name__ == "__main__":
    unittest.main()
