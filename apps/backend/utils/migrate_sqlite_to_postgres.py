"""
SQLite to PostgreSQL Migration Script - Categories Only

This script migrates ONLY the categories table from SQLite to PostgreSQL.

Usage:
    python -m utils.migrate_sqlite_to_postgres
"""
import os
import sys
from datetime import datetime

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import sessionmaker, Session

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import logging setup first so diagnostics can log useful info
from config.logging_config import setup_logging

logger = setup_logging(__name__)

# Resolve SQLite source path explicitly (allow override via env var)
DEFAULT_SQLITE_PATH = os.environ.get(
    "SOURCE_DATABASE_PATH",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "financial_transactions.db")),
)
SOURCE_DATABASE_PATH = os.path.abspath(DEFAULT_SQLITE_PATH)
SOURCE_DATABASE_URL = f"sqlite:///{SOURCE_DATABASE_PATH}"

# Target URL remains as configured (adjust via env if you like)
TARGET_DATABASE_URL = os.environ.get(
    "TARGET_DATABASE_URL",
    "postgresql://ftm_user:@localhost:5433/financial_transactions",
)


def diagnose_source(path: str) -> bool:
    """
    Diagnose the SQLite source file and report useful information to logs.

    Returns True if the file exists and the inspector finds tables (not a guaranteed proof
    that the ORM mappings will import correctly, but it's a helpful early check).
    """
    logger.info(f"Diagnosing source SQLite at: {path}")

    if not os.path.exists(path):
        logger.error(f"SQLite file not found at: {path}")
        return False

    try:
        size = os.path.getsize(path)
        logger.info(f"  ✓ File exists, size={size} bytes")
    except Exception as e:
        logger.warning(f"  ⚠ Could not stat file: {e}")

    try:
        engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        logger.info(f"  ✓ Inspector found tables: {tables}")
    except Exception as e:
        logger.error(f"  ✗ Inspector failed: {e}")
        return False

    # Try a lightweight query against categories table using reflection (no ORM imports yet)
    if "categories" in [t.lower() for t in tables]:
        try:
            with engine.connect() as conn:
                result = conn.execute(text("SELECT count(1) as c FROM categories LIMIT 1"))
                row = result.fetchone()
                if row is not None:
                    logger.info(f"  ✓ Categories table row count (quick check): {row[0]}")
        except Exception as e:
            logger.warning(f"  ⚠ Could not run quick categories count: {e}")

    return True


# Run diagnostics before importing ORM models to avoid early mapper configuration issues
if not diagnose_source(SOURCE_DATABASE_PATH):
    logger.warning(
        "Source diagnosis failed or reported issues. Please verify SOURCE_DATABASE_PATH and the SQLite file."
    )

# Now import ORM models (after diagnostics) to avoid triggering mappers before we've checked the DB file
from database.models import Base, Category


class DatabaseMigrator:
    """Handles migration from SQLite to PostgreSQL."""

    def __init__(self, source_url: str, target_url: str):
        """
        Initialize the migrator with source and target database URLs.

        Args:
            source_url: SQLite database URL
            target_url: PostgreSQL database URL
        """
        self.source_url = source_url
        self.target_url = target_url

        # Create engines
        logger.info(f"Connecting to source database: {source_url[:30]}...")
        self.source_engine = create_engine(
            source_url,
            connect_args={"check_same_thread": False} if source_url.startswith("sqlite") else {}
        )

        logger.info(f"Connecting to target database: {target_url[:30]}...")
        self.target_engine = create_engine(target_url, pool_pre_ping=True)

        # Create session makers
        self.SourceSession = sessionmaker(bind=self.source_engine)
        self.TargetSession = sessionmaker(bind=self.target_engine)

        # Only migrate categories
        self.migration_order = [Category]

    def validate_source_database(self) -> bool:
        """
        Validate that the source database exists and has data.

        Returns:
            bool: True if validation passes, False otherwise
        """
        try:
            inspector = inspect(self.source_engine)
            tables = inspector.get_table_names()

            if not tables:
                logger.error("Source database has no tables")
                return False

            logger.info(f"Source database contains {len(tables)} tables: {', '.join(tables)}")

            # Check for categories data
            with self.SourceSession() as session:
                category_count = session.query(Category).count()

                logger.info(f"Source database statistics:")
                logger.info(f"  - Categories: {category_count}")

            return True

        except Exception as e:
            logger.error(f"Source database validation failed: {e}")
            return False

    def create_target_schema(self) -> bool:
        """
        Create all tables in the target PostgreSQL database.

        Returns:
            bool: True if successful, False otherwise
        """
        try:
            logger.info("Creating target database schema...")
            Base.metadata.create_all(bind=self.target_engine)
            logger.info("Target schema created successfully")
            return True
        except Exception as e:
            logger.error(f"Failed to create target schema: {e}")
            return False

    def migrate_table(self, model_class, source_session: Session, target_session: Session) -> int:
        """
        Migrate data from one table to another.

        Uses PostgreSQL's INSERT ... ON CONFLICT DO NOTHING to safely skip
        existing records without raising errors.

        Args:
            model_class: SQLAlchemy model class to migrate
            source_session: Source database session
            target_session: Target database session

        Returns:
            int: Number of records migrated
        """
        table_name = model_class.__tablename__
        logger.info(f"Migrating table: {table_name}")

        try:
            # Fetch all records from source
            records = source_session.query(model_class).all()
            count = len(records)

            if count == 0:
                logger.info(f"  ✓ No records to migrate for {table_name}")
                return 0

            # Prepare records for insertion
            records_data = []
            for record in records:
                # Convert ORM object to dict
                record_dict = {}
                for column in model_class.__table__.columns:
                    value = getattr(record, column.name)
                    record_dict[column.name] = value
                records_data.append(record_dict)

            # Use PostgreSQL INSERT ... ON CONFLICT to skip duplicates
            # This safely handles cases where records already exist
            inserted_count = 0
            for record_dict in records_data:
                stmt = insert(model_class.__table__).values(**record_dict)
                # Skip if primary key (id) already exists
                stmt = stmt.on_conflict_do_nothing(index_elements=['id'])
                result = target_session.execute(stmt)
                # Track how many were actually inserted (not skipped)
                rc = getattr(result, 'rowcount', None)
                if rc is not None and rc > 0:
                    inserted_count += 1

            logger.info(
                f"  ✓ Migrated {inserted_count} records from {table_name} ({count - inserted_count} skipped as duplicates)")
            return count

        except Exception as e:
            logger.error(f"  ✗ Failed to migrate {table_name}: {e}")
            raise

    def reset_sequences(self, target_session: Session) -> None:
        """
        Reset PostgreSQL sequences to match the maximum ID values.

        This ensures that new records will have IDs that don't conflict
        with migrated data. Uses pg_get_serial_sequence for robust
        sequence detection.

        Args:
            target_session: Target database session
        """
        logger.info("Resetting PostgreSQL sequences...")

        for model_class in self.migration_order:
            table_name = model_class.__tablename__
            try:
                # Get the maximum ID from the table
                from sqlalchemy import func
                max_id_result = target_session.query(func.max(model_class.id)).scalar()

                if max_id_result:
                    # Use pg_get_serial_sequence to get the actual sequence name
                    # This is more robust than assuming the sequence name format
                    seq_query = text(
                        "SELECT setval(pg_get_serial_sequence(:table, :column), "
                        ":max_val, true)"
                    )
                    target_session.execute(
                        seq_query,
                        {
                            "table": table_name,
                            "column": "id",
                            "max_val": max_id_result
                        }
                    )
                    logger.info(f"  ✓ Reset sequence for {table_name} to {max_id_result}")
                else:
                    logger.info(f"  ℹ No records in {table_name}, skipping sequence reset")

            except Exception as e:
                logger.warning(f"  ⚠ Could not reset sequence for {table_name}: {e}")

    def verify_migration(self) -> bool:
        """
        Verify that the migration was successful by comparing record counts.

        Returns:
            bool: True if verification passes, False otherwise
        """
        logger.info("Verifying migration...")

        try:
            with self.SourceSession() as source_session, self.TargetSession() as target_session:
                all_match = True

                for model_class in self.migration_order:
                    table_name = model_class.__tablename__
                    source_count = source_session.query(model_class).count()
                    target_count = target_session.query(model_class).count()

                    if source_count != target_count:
                        logger.error(
                            f"  ✗ Count mismatch for {table_name}: "
                            f"source={source_count}, target={target_count}"
                        )
                        all_match = False
                    else:
                        logger.info(
                            f"  ✓ {table_name}: {source_count} records (match)"
                        )

                return all_match

        except Exception as e:
            logger.error(f"Verification failed: {e}")
            return False

    def run_migration(self) -> bool:
        """
        Execute the complete migration process.

        Returns:
            bool: True if migration successful, False otherwise
        """
        start_time = datetime.now()
        logger.info("=" * 80)
        logger.info("Starting SQLite to PostgreSQL migration")
        logger.info("=" * 80)

        try:
            # Step 1: Validate source
            if not self.validate_source_database():
                logger.error("Source database validation failed. Aborting migration.")
                return False

            # Step 2: Create target schema
            if not self.create_target_schema():
                logger.error("Failed to create target schema. Aborting migration.")
                return False

            # Step 3: Migrate data
            logger.info("\nMigrating data...")
            total_records = 0

            with self.SourceSession() as source_session, self.TargetSession() as target_session:
                try:
                    for model_class in self.migration_order:
                        count = self.migrate_table(model_class, source_session, target_session)
                        total_records += count

                    # Commit all changes
                    target_session.commit()
                    logger.info(f"\n✓ Successfully migrated {total_records} total records")

                    # Step 4: Reset sequences
                    self.reset_sequences(target_session)
                    target_session.commit()

                except Exception as e:
                    target_session.rollback()
                    logger.error(f"Migration failed, rolled back: {e}")
                    raise

            # Step 5: Verify migration
            if not self.verify_migration():
                logger.error("Migration verification failed!")
                return False

            # Success
            duration = datetime.now() - start_time
            logger.info("\n" + "=" * 80)
            logger.info(f"✓ Migration completed successfully in {duration}")
            logger.info("=" * 80)
            return True

        except Exception as e:
            logger.error(f"\n✗ Migration failed: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return False


def main():
    """Main entry point for the migration script."""
    logger.info("Starting Categories-Only Migration")

    # Confirm migration
    print("\n" + "=" * 80)
    print("SQLite to PostgreSQL Migration - CATEGORIES ONLY")
    print("=" * 80)
    print(f"Source: {SOURCE_DATABASE_URL}")
    print(f"Target: {TARGET_DATABASE_URL}")
    print("\nWARNING: This will migrate ONLY the categories table to PostgreSQL.")
    print("=" * 80)

    response = input("\nProceed with migration? (yes/no): ").strip().lower()
    if response != "yes":
        print("Migration cancelled.")
        sys.exit(0)

    # Run migration
    migrator = DatabaseMigrator(SOURCE_DATABASE_URL, TARGET_DATABASE_URL)
    success = migrator.run_migration()

    if success:
        print("\n✓ Categories migration completed successfully!")
        print("\nNext steps:")
        print("1. Verify categories data in PostgreSQL")
        print("2. Migrate other tables as needed")
        sys.exit(0)
    else:
        print("\n✗ Migration failed. Check the logs for details.")
        sys.exit(1)


if __name__ == "__main__":
    main()
