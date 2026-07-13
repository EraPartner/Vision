import os
import sys
from logging.config import fileConfig
from dotenv import load_dotenv

from alembic import context
from sqlalchemy import engine_from_config
from sqlalchemy import pool

# Load environment variables from .env.local if present
config_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_local_path = os.path.join(config_dir, "config", ".env.local")
if os.path.exists(env_local_path):
    load_dotenv(env_local_path, override=True)

# Get database URL from environment variable. No credentialed fallback: shipping
# a default password ("ftm_password") invites standing a DB up on it. Fail fast
# instead so the operator must supply DATABASE_URL (compose/.env.local do).
#
# DATABASE_URL_MIGRATIONS takes precedence when set: in the least-privilege
# setup (docker/postgres-init/01-app-role.sh) the runtime pool's DATABASE_URL
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

# Try to load models for autogenerate support (optional - continues if fails)
target_metadata = None
try:
    sys.path.insert(0, os.path.join(config_dir, "apps", "backend"))
    from database.models import Base

    target_metadata = Base.metadata

    try:
        from database import raw_transaction_models  # noqa: F401
    except Exception:
        pass  # Continue even if raw_transaction_models can't be imported
except Exception as e:
    # If models can't be imported, Alembic will still work for migrations
    # but autogenerate functionality will be limited
    import logging

    logging.getLogger(__name__).warning(
        f"Could not import database models for autogenerate support: {e}\n"
        "Alembic will still work for manual migrations."
    )

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
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
