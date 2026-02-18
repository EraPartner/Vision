"""
SQLite to PostgreSQL Migration Script

This script migrates data from SQLite to PostgreSQL while preserving:
- All table data and relationships
- Primary key sequences
- Foreign key integrity
- Transaction atomicity

Usage:
    python -m utils.migrate_sqlite_to_postgres

Environment Variables Required:
    SOURCE_DATABASE_URL: SQLite database URL (e.g., sqlite:///./financial_transactions.db)
    TARGET_DATABASE_URL: PostgreSQL database URL (e.g., postgresql://user:pass@localhost/dbname)
"""
import os
import sys
from datetime import datetime

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, Session

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.models import (
    Base, Transaction, Category, Recipient, ImportBatch,
    PlannedTransaction, ExchangeRate, PlannedTransactionExecution
)
from config.logging_config import setup_logging

logger = setup_logging(__name__)


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

        # Define migration order (respects foreign key dependencies)
        self.migration_order = [
            Category,
            Recipient,
            ImportBatch,
            Transaction,
            PlannedTransaction,
            ExchangeRate,
            PlannedTransactionExecution,
        ]

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

            # Check for data
            with self.SourceSession() as session:
                transaction_count = session.query(Transaction).count()
                category_count = session.query(Category).count()
                recipient_count = session.query(Recipient).count()

                logger.info(f"Source database statistics:")
                logger.info(f"  - Transactions: {transaction_count}")
                logger.info(f"  - Categories: {category_count}")
                logger.info(f"  - Recipients: {recipient_count}")

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

            # Bulk insert into target
            target_session.bulk_insert_mappings(model_class, records_data)

            logger.info(f"  ✓ Migrated {count} records from {table_name}")
            return count

        except Exception as e:
            logger.error(f"  ✗ Failed to migrate {table_name}: {e}")
            raise

    def reset_sequences(self, target_session: Session) -> None:
        """
        Reset PostgreSQL sequences to match the maximum ID values.

        This ensures that new records will have IDs that don't conflict
        with migrated data.

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
                    sequence_name = f"{table_name}_id_seq"
                    next_val = max_id_result + 1

                    # Reset sequence
                    target_session.execute(
                        text(f"SELECT setval('{sequence_name}', :next_val, false)"),
                        {"next_val": next_val}
                    )
                    logger.info(f"  ✓ Reset sequence {sequence_name} to {next_val}")

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
    # Load environment variables from config/.env.local
    # Get the backend directory (parent of utils directory)
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(backend_dir, "config", ".env.local")

    load_dotenv(dotenv_path=env_path)
    logger.info(f"Loading environment from: {env_path}")

    # Get database URLs from environment
    source_url = os.getenv(
        "SOURCE_DATABASE_URL",
        "sqlite:///./financial_transactions.db"
    )
    target_url = os.getenv("TARGET_DATABASE_URL")

    if not target_url:
        logger.error(
            "TARGET_DATABASE_URL environment variable is required.\n"
            "Example: postgresql://user:password@localhost:5432/financial_db"
        )
        sys.exit(1)

    # Confirm migration
    print("\n" + "=" * 80)
    print("SQLite to PostgreSQL Migration")
    print("=" * 80)
    print(f"Source: {source_url}")
    print(f"Target: {target_url[:50]}...")
    print("\nWARNING: This will create tables and migrate all data to the target database.")
    print("=" * 80)

    response = input("\nProceed with migration? (yes/no): ").strip().lower()
    if response != "yes":
        print("Migration cancelled.")
        sys.exit(0)

    # Run migration
    migrator = DatabaseMigrator(source_url, target_url)
    success = migrator.run_migration()

    if success:
        print("\n✓ Migration completed successfully!")
        print("\nNext steps:")
        print("1. Update your DATABASE_URL in .env.local to point to PostgreSQL")
        print("2. Restart your application")
        print("3. Verify that all data is accessible")
        sys.exit(0)
    else:
        print("\n✗ Migration failed. Check the logs for details.")
        sys.exit(1)


if __name__ == "__main__":
    main()
