#!/usr/bin/env python3
"""
Post-Migration Verification Script

This script verifies that the PostgreSQL migration was successful by:
- Testing database connectivity
- Comparing record counts between databases
- Checking data integrity
- Validating foreign key relationships
- Testing a sample of actual data matches

Usage:
    python -m utils.verify_migration

Environment Variables:
    SOURCE_DATABASE_URL: Original SQLite database URL
    TARGET_DATABASE_URL: New PostgreSQL database URL
"""
import os
import sys
from typing import Tuple

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.models import (
    Transaction, Category, Recipient, ImportBatch,
    PlannedTransaction, ExchangeRate, PlannedTransactionExecution
)
from config.logging_config import setup_logging

logger = setup_logging(__name__)


class MigrationVerifier:
    """Verifies the success of a database migration."""

    def __init__(self, source_url: str, target_url: str):
        """Initialize verifier with source and target database URLs."""
        self.source_url = source_url
        self.target_url = target_url

        # Create engines
        self.source_engine = create_engine(
            source_url,
            connect_args={"check_same_thread": False} if source_url.startswith("sqlite") else {}
        )
        self.target_engine = create_engine(target_url, pool_pre_ping=True)

        # Create session makers
        self.SourceSession = sessionmaker(bind=self.source_engine)
        self.TargetSession = sessionmaker(bind=self.target_engine)

        # Define models to check
        self.models = [
            Category,
            Recipient,
            ImportBatch,
            Transaction,
            PlannedTransaction,
            ExchangeRate,
            PlannedTransactionExecution,
        ]

    def test_connectivity(self) -> Tuple[bool, bool]:
        """Test connectivity to both databases."""
        logger.info("Testing database connectivity...")

        source_ok = False
        target_ok = False

        try:
            with self.source_engine.connect() as conn:
                conn.execute(text("SELECT 1"))
                source_ok = True
                logger.info("  ✓ Source database connection OK")
        except Exception as e:
            logger.error(f"  ✗ Source database connection FAILED: {e}")

        try:
            with self.target_engine.connect() as conn:
                conn.execute(text("SELECT 1"))
                target_ok = True
                logger.info("  ✓ Target database connection OK")
        except Exception as e:
            logger.error(f"  ✗ Target database connection FAILED: {e}")

        return source_ok, target_ok

    def verify_record_counts(self) -> bool:
        """Verify that record counts match between databases."""
        logger.info("\nVerifying record counts...")

        all_match = True
        with self.SourceSession() as source_session, self.TargetSession() as target_session:
            for model in self.models:
                table_name = model.__tablename__

                try:
                    source_count = source_session.query(model).count()
                    target_count = target_session.query(model).count()

                    if source_count != target_count:
                        logger.error(
                            f"  ✗ {table_name}: source={source_count}, target={target_count} (MISMATCH)"
                        )
                        all_match = False
                    else:
                        logger.info(f"  ✓ {table_name}: {source_count} records (match)")
                except Exception as e:
                    logger.error(f"  ✗ {table_name}: Error checking counts: {e}")
                    all_match = False

        return all_match

    def verify_foreign_keys(self) -> bool:
        """Verify foreign key relationships are intact."""
        logger.info("\nVerifying foreign key relationships...")

        all_ok = True
        with self.TargetSession() as session:
            try:
                # Test Transaction -> Recipient relationship
                orphaned_txns = session.query(Transaction).filter(
                    ~Transaction.recipient_id.in_(
                        session.query(Recipient.id)
                    )
                ).count()

                if orphaned_txns > 0:
                    logger.error(f"  ✗ Found {orphaned_txns} transactions with invalid recipient_id")
                    all_ok = False
                else:
                    logger.info("  ✓ All transactions have valid recipients")

                # Test Transaction -> Category relationship (nullable)
                invalid_categories = session.query(Transaction).filter(
                    Transaction.category_id.isnot(None),
                    ~Transaction.category_id.in_(
                        session.query(Category.id)
                    )
                ).count()

                if invalid_categories > 0:
                    logger.error(f"  ✗ Found {invalid_categories} transactions with invalid category_id")
                    all_ok = False
                else:
                    logger.info("  ✓ All transactions have valid categories")

                # Test Recipient -> Category relationship (nullable)
                invalid_default_cats = session.query(Recipient).filter(
                    Recipient.default_category_id.isnot(None),
                    ~Recipient.default_category_id.in_(
                        session.query(Category.id)
                    )
                ).count()

                if invalid_default_cats > 0:
                    logger.error(f"  ✗ Found {invalid_default_cats} recipients with invalid default_category_id")
                    all_ok = False
                else:
                    logger.info("  ✓ All recipients have valid default categories")

                # Test PlannedTransaction relationships
                orphaned_planned = session.query(PlannedTransaction).filter(
                    ~PlannedTransaction.recipient_id.in_(
                        session.query(Recipient.id)
                    )
                ).count()

                if orphaned_planned > 0:
                    logger.error(f"  ✗ Found {orphaned_planned} planned transactions with invalid recipient_id")
                    all_ok = False
                else:
                    logger.info("  ✓ All planned transactions have valid recipients")

            except Exception as e:
                logger.error(f"  ✗ Error verifying foreign keys: {e}")
                all_ok = False

        return all_ok

    def sample_data_check(self) -> bool:
        """Check that sample data matches between databases."""
        logger.info("\nVerifying sample data integrity...")

        all_match = True
        with self.SourceSession() as source_session, self.TargetSession() as target_session:
            try:
                # Check first 5 transactions
                source_txns = source_session.query(Transaction).order_by(Transaction.id).limit(5).all()
                target_txns = target_session.query(Transaction).order_by(Transaction.id).limit(5).all()

                if len(source_txns) != len(target_txns):
                    logger.error(f"  ✗ Sample size mismatch: {len(source_txns)} vs {len(target_txns)}")
                    all_match = False
                else:
                    for src, tgt in zip(source_txns, target_txns):
                        if (src.id != tgt.id or
                                src.amount != tgt.amount or
                                src.date != tgt.date or
                                src.recipient_id != tgt.recipient_id):
                            logger.error(f"  ✗ Transaction {src.id} data mismatch")
                            all_match = False
                            break
                    else:
                        logger.info(f"  ✓ Sampled {len(source_txns)} transactions - all match")

                # Check categories
                source_cats = source_session.query(Category).order_by(Category.id).limit(5).all()
                target_cats = target_session.query(Category).order_by(Category.id).limit(5).all()

                if len(source_cats) == len(target_cats):
                    for src, tgt in zip(source_cats, target_cats):
                        if (src.id != tgt.id or
                                src.general != tgt.general or
                                src.detail != tgt.detail):
                            logger.error(f"  ✗ Category {src.id} data mismatch")
                            all_match = False
                            break
                    else:
                        logger.info(f"  ✓ Sampled {len(source_cats)} categories - all match")

            except Exception as e:
                logger.error(f"  ✗ Error sampling data: {e}")
                all_match = False

        return all_match

    def verify_sequences(self) -> bool:
        """Verify that PostgreSQL sequences are properly set."""
        logger.info("\nVerifying PostgreSQL sequences...")

        all_ok = True
        with self.TargetSession() as session:
            for model in self.models:
                table_name = model.__tablename__
                sequence_name = f"{table_name}_id_seq"

                try:
                    # Get max ID from table
                    from sqlalchemy import func
                    max_id = session.query(func.max(model.id)).scalar()

                    if max_id is not None:
                        # Get current sequence value
                        result = session.execute(
                            text(f"SELECT last_value FROM {sequence_name}")
                        ).scalar()

                        if result < max_id:
                            logger.error(
                                f"  ✗ {sequence_name}: last_value={result}, max_id={max_id} (sequence too low!)"
                            )
                            all_ok = False
                        else:
                            logger.info(f"  ✓ {sequence_name}: last_value={result}, max_id={max_id}")

                except Exception as e:
                    logger.warning(f"  ⚠ Could not verify {sequence_name}: {e}")

        return all_ok

    def run_verification(self) -> bool:
        """Run complete verification suite."""
        logger.info("=" * 80)
        logger.info("PostgreSQL Migration Verification")
        logger.info("=" * 80)

        # Test connectivity
        source_ok, target_ok = self.test_connectivity()
        if not (source_ok and target_ok):
            logger.error("\n✗ Database connectivity check failed!")
            return False

        # Verify record counts
        if not self.verify_record_counts():
            logger.error("\n✗ Record count verification failed!")
            return False

        # Verify foreign keys
        if not self.verify_foreign_keys():
            logger.error("\n✗ Foreign key verification failed!")
            return False

        # Sample data check
        if not self.sample_data_check():
            logger.error("\n✗ Sample data verification failed!")
            return False

        # Verify sequences
        if not self.verify_sequences():
            logger.warning("\n⚠ Sequence verification had warnings (non-critical)")

        # Success!
        logger.info("\n" + "=" * 80)
        logger.info("✓ All verification checks passed!")
        logger.info("=" * 80)
        logger.info("\nYour migration was successful. You can now:")
        logger.info("1. Update DATABASE_URL in config/.env.local to use PostgreSQL")
        logger.info("2. Restart your application")
        logger.info("3. Test all functionality to ensure everything works")
        logger.info("\nKeep your SQLite backup for at least a few weeks as a safety measure.")
        return True


def main():
    """Main entry point."""
    load_dotenv()

    # Get database URLs
    source_url = os.getenv("SOURCE_DATABASE_URL", "sqlite:///./financial_transactions.db")
    target_url = os.getenv("TARGET_DATABASE_URL")

    if not target_url:
        logger.error(
            "TARGET_DATABASE_URL environment variable is required.\n"
            "Set it in your .env file or environment."
        )
        sys.exit(1)

    print(f"\nSource: {source_url[:60]}...")
    print(f"Target: {target_url[:60]}...\n")

    # Run verification
    verifier = MigrationVerifier(source_url, target_url)
    success = verifier.run_verification()

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
