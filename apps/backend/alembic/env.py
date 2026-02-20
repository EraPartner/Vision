import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config
from sqlalchemy import pool

# Add the parent directory to path to import application modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import application configuration and models
from config.config import get_settings
# Import Base and ensure all model modules are loaded so their Table objects
# are registered on Base.metadata. Importing raw_transaction_models explicitly
# makes sure TransactionRawReference and other cross-module classes are
# present when Alembic inspects target_metadata.
from database.models import Base

try:
    # Explicit import to register models declared in a separate module
    from database import raw_transaction_models  # noqa: F401
except Exception:
    # Log in case the import fails but continue; Alembic will still attempt autogenerate
    import logging

    logging.getLogger(__name__).warning('Could not import database.raw_transaction_models during Alembic env setup')

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Get database URL from application settings
settings = get_settings()
database_url = settings.database.url

# Handle SQLite path resolution
if database_url.startswith("sqlite") and not database_url.startswith("sqlite:///"):
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    default_db_path = os.path.join(backend_dir, "financial_transactions.db")
    database_url = f"sqlite:///{default_db_path}"

# Override sqlalchemy.url with the application's configured database URL
config.set_main_option("sqlalchemy.url", database_url)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Set target metadata for autogenerate support
target_metadata = Base.metadata


# Helper to determine render_as_batch for SQLite (required for certain ALTER ops)
def _render_as_batch_for_sqlite(connectable_or_url):
    try:
        name = None
        if hasattr(connectable_or_url, 'dialect'):
            name = connectable_or_url.dialect.name
        elif isinstance(connectable_or_url, str):
            # URL string like sqlite:////path
            name = connectable_or_url.split(':', 1)[0]
        return name == 'sqlite'
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
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
