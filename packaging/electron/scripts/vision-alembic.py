"""Minimal PyInstaller entry point for Vision's pinned Alembic runtime."""

import sys

from alembic.config import main


def runtime_self_test() -> None:
    """Import modules loaded dynamically by Vision's external Alembic files."""
    from logging.config import fileConfig

    from dotenv import load_dotenv
    import psycopg2
    import sqlalchemy.dialects.postgresql

    assert fileConfig is not None
    assert load_dotenv is not None
    assert psycopg2 is not None
    assert sqlalchemy.dialects.postgresql is not None
    print("vision-alembic runtime ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--vision-runtime-self-test"]:
        runtime_self_test()
    else:
        main(argv=sys.argv[1:], prog="alembic")
