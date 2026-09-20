import os
import hashlib
import json
import re
from logging.config import fileConfig
from dotenv import load_dotenv

from alembic import context
from sqlalchemy import engine_from_config
from sqlalchemy import pool
from sqlalchemy import text

# Load environment variables from .env.local if present. The native macOS
# runtime supplies an explicit generated environment and must never let a
# source checkout's development .env.local redirect Alembic to another
# database.
config_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_local_path = os.path.join(config_dir, "config", ".env.local")
skip_config_env_local = os.getenv("VISION_SKIP_CONFIG_ENV_LOCAL", "").lower() in {
    "1",
    "true",
    "yes",
}
if not skip_config_env_local and os.path.exists(env_local_path):
    load_dotenv(env_local_path, override=True)

# Get database URL from environment variable. No credentialed fallback: shipping
# a default password ("ftm_password") invites standing a DB up on it. Fail fast
# instead so the operator must supply DATABASE_URL (compose/.env.local do).
#
# DATABASE_URL_MIGRATIONS takes precedence when set: in the least-privilege
# setup, the runtime pool's DATABASE_URL
# points at the non-superuser ftm_app role, while migrations keep the
# privileged ftm_user role for DDL.
database_url = os.getenv("DATABASE_URL_MIGRATIONS") or os.getenv("DATABASE_URL")
if not database_url:
    raise SystemExit(
        "DATABASE_URL is not set. Set it in the environment or config/.env.local "
        "before running migrations."
    )

# Handle SQLite path resolution if using SQLite
if database_url.startswith("sqlite") and not database_url.startswith("sqlite:///"):
    default_db_path = os.path.join(config_dir, "financial_transactions.db")
    database_url = f"sqlite:///{default_db_path}"

# The backend is Node.js; there are no Python SQLAlchemy models to import.
# Migrations are hand-written SQL, so --autogenerate is not supported.
target_metadata = None

AUDIT_CHAIN_REVISION = "0117_audit_chain"
AUDIT_GENESIS_HASH = "0" * 64
MAX_SAFE_INTEGER = 2**53 - 1


def _revision_at_or_after_audit_chain(revision_map, revision_ids):
    """Follow Alembic's graph, rather than assuming revision names sort."""
    pending = list(revision_ids)
    visited = set()
    while pending:
        revision_id = pending.pop()
        if revision_id == AUDIT_CHAIN_REVISION:
            return True
        if revision_id in visited:
            continue
        visited.add(revision_id)
        revision = revision_map.get_revision(revision_id)
        if revision is None:
            raise RuntimeError(f"Unknown migration revision: {revision_id}")
        parents = revision.down_revision
        if isinstance(parents, str):
            pending.append(parents)
        elif parents:
            pending.extend(parents)
    return False


def _append_migration_audit(ctx, step, heads, run_args):
    """Append after Alembic changes the version row, before its transaction commits.

    The payload intentionally contains only ASCII revision identifiers and
    strings. JSON's sorted-key encoding then matches canonicalAuditPayload in
    the Node audit chain; the SHA-256 envelope matches hashAuditEntry v1.
    """
    connection = ctx.connection
    if connection.dialect.name != "postgresql":
        return

    has_chain = connection.execute(
        text(
            "SELECT to_regclass('audit_chain_head') IS NOT NULL "
            "AND to_regclass('audit_chain_entries') IS NOT NULL"
        )
    ).scalar_one()
    needs_chain = _revision_at_or_after_audit_chain(
        step.revision_map, step.up_revision_ids
    )
    # An empty 0117 downgrade drops the chain itself. A nonempty chain is
    # rejected inside that revision before this callback can run.
    removing_chain = (
        not step.is_upgrade
        and not step.is_stamp
        and AUDIT_CHAIN_REVISION in step.up_revision_ids
    )
    if not has_chain:
        if needs_chain and not removing_chain:
            raise RuntimeError("Audit chain is missing after a chained revision")
        return

    if any(not revision.isascii() for revision in (*step.up_revision_ids, *heads)):
        raise ValueError("Audit migration revision IDs must be ASCII")
    payload = {
        "stream": "schema_migration",
        "event": "version_changed" if step.is_stamp else "revision_applied",
        "direction": "stamp"
        if step.is_stamp
        else ("upgrade" if step.is_upgrade else "downgrade"),
        "revision": step.up_revision_id or "",
        "heads": sorted(heads),
    }
    encoded_payload = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    head = (
        connection.execute(
            text(
                "SELECT last_sequence, last_hash FROM audit_chain_head "
                "WHERE singleton = true FOR UPDATE"
            )
        )
        .mappings()
        .one()
    )
    last_sequence = int(head["last_sequence"])
    if last_sequence < 0 or last_sequence >= MAX_SAFE_INTEGER:
        raise OverflowError("Audit chain sequence is outside the safe range")
    latest = (
        connection.execute(
            text(
                "SELECT sequence, entry_hash FROM audit_chain_entries "
                "ORDER BY sequence DESC LIMIT 1"
            )
        )
        .mappings()
        .first()
    )
    expected_sequence = int(latest["sequence"]) if latest else 0
    expected_hash = str(latest["entry_hash"]) if latest else AUDIT_GENESIS_HASH
    previous_hash = str(head["last_hash"])
    if not re.fullmatch(r"[0-9a-f]{64}", previous_hash):
        raise RuntimeError("Audit chain head hash is invalid")
    if last_sequence != expected_sequence or previous_hash != expected_hash:
        raise RuntimeError("Audit chain head does not match stored history")
    sequence = last_sequence + 1
    envelope = (
        f'["vision.audit.entry",1,{sequence},"{previous_hash}",{encoded_payload}]'
    )
    entry_hash = hashlib.sha256(envelope.encode("utf-8")).hexdigest()
    connection.execute(
        text(
            "INSERT INTO audit_chain_entries "
            "(sequence, version, previous_hash, entry_hash, payload) "
            "VALUES (:sequence, 1, :previous_hash, :entry_hash, "
            "CAST(:payload AS jsonb))"
        ),
        {
            "sequence": sequence,
            "previous_hash": previous_hash,
            "entry_hash": entry_hash,
            "payload": encoded_payload,
        },
    )
    updated = connection.execute(
        text(
            "UPDATE audit_chain_head SET last_sequence = :sequence, "
            "last_hash = :entry_hash, updated_at = now() "
            "WHERE singleton = true AND last_sequence = :previous_sequence "
            "AND last_hash = :previous_hash"
        ),
        {
            "sequence": sequence,
            "entry_hash": entry_hash,
            "previous_sequence": last_sequence,
            "previous_hash": previous_hash,
        },
    )
    if updated.rowcount != 1:
        raise RuntimeError("Audit chain head changed during migration append")


# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Override sqlalchemy.url with the configured database URL
config.set_main_option("sqlalchemy.url", database_url)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)


# Helper to determine render_as_batch for SQLite (required for certain ALTER ops)
def _render_as_batch_for_sqlite(connectable_or_url):
    try:
        name = None
        if hasattr(connectable_or_url, "dialect"):
            name = connectable_or_url.dialect.name
        elif isinstance(connectable_or_url, str):
            # URL string like sqlite:////path
            name = connectable_or_url.split(":", 1)[0]
        return name == "sqlite"
    except Exception:
        return False


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
            render_as_batch=_render_as_batch_for_sqlite(connection),
            # Commit each migration in its own transaction (Postgres DDL is
            # transactional). Previously the whole pending chain ran inside one
            # transaction, so if a long upgrade was killed at the migrate.js
            # timeout the *entire* chain rolled back and re-ran identically on
            # every boot — never making progress. Per-migration commits mean a
            # kill only loses the in-flight migration; completed ones persist
            # and a re-run resumes from where it stopped. SQLite (dev/test) does
            # not support transactional DDL, so keep the single-transaction
            # behaviour there.
            transaction_per_migration=connection.dialect.name != "sqlite",
            on_version_apply=_append_migration_audit,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
