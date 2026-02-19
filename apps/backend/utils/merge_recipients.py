#!/usr/bin/env python3
"""
Recipient Merge Utility

This script identifies and merges duplicate recipients in the database.
Recipients are considered duplicates if they share the same name.

Features:
- Dry-run mode to preview changes without modifying the database
- Identifies cases where category IDs differ between duplicates
- Merges recipients while preserving maximum information
- Updates all related transactions to point to the merged recipient
- Comprehensive logging and reporting

Usage:
    python -m utils.merge_recipients --dry-run  # Preview changes only
    python -m utils.merge_recipients            # Execute merge
    python -m utils.merge_recipients --name "IBE BRICHAU"  # Merge specific recipient
"""

import argparse
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Set

from sqlalchemy import func, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from config.logging_config import setup_logging
from database.models import Base, Recipient, Transaction, PlannedTransaction

logger = setup_logging(__name__, use_json=False)

# Hardcoded database URL for merge script
HARDCODED_DATABASE_URL = "sqlite:///financial_transactions.db"


@dataclass
class RecipientInfo:
    """Information about a recipient for merge analysis."""
    id: int
    name: str
    account_number: Optional[str]
    default_category_id: Optional[int]
    notes: Optional[str]
    address: Optional[str]
    is_active: bool
    transaction_count: int
    planned_transaction_count: int
    created_at: datetime


@dataclass
class MergeGroup:
    """Group of duplicate recipients to be merged."""
    name: str
    recipients: List[RecipientInfo]
    category_ids: Set[Optional[int]]
    has_category_conflict: bool
    total_transactions: int
    total_planned_transactions: int

    def __post_init__(self):
        """Calculate derived properties."""
        self.category_ids = {r.default_category_id for r in self.recipients}
        # Conflict if more than one non-null category ID
        non_null_categories = {cid for cid in self.category_ids if cid is not None}
        self.has_category_conflict = len(non_null_categories) > 1
        self.total_transactions = sum(r.transaction_count for r in self.recipients)
        self.total_planned_transactions = sum(r.planned_transaction_count for r in self.recipients)


class RecipientMerger:
    """Handles the merging of duplicate recipients."""

    def __init__(self, db: Session, dry_run: bool = True):
        """
        Initialise the recipient merger.

        Args:
            db: Database session
            dry_run: If True, only preview changes without modifying the database
        """
        self.db = db
        self.dry_run = dry_run
        self.merge_groups: List[MergeGroup] = []
        self.category_conflicts: List[MergeGroup] = []

    def find_duplicates(self, specific_name: Optional[str] = None) -> List[MergeGroup]:
        """
        Find all duplicate recipients in the database.

        Merging rules:
        - Recipients with the same name are candidates for merging
        - If both have account_numbers, they must match to be merged
        - If one or both have NULL account_number, they can be merged based on name alone

        Args:
            specific_name: If provided, only find duplicates for this recipient name

        Returns:
            List of merge groups containing duplicate recipients
        """
        logger.info("Scanning for duplicate recipients...")

        # Query to find all recipients with their transaction counts
        query = (
            self.db.query(
                Recipient.id,
                Recipient.name,
                Recipient.account_number,
                Recipient.default_category_id,
                Recipient.notes,
                Recipient.address,
                Recipient.is_active,
                Recipient.created_at,
                func.count(Transaction.id.distinct()).label('transaction_count')
            )
            .filter(Recipient.is_active == True)  # Only query active recipients
            .outerjoin(Transaction, Recipient.id == Transaction.recipient_id)
            .group_by(Recipient.id)
        )

        if specific_name:
            query = query.filter(Recipient.name == specific_name.upper())

        query = query.order_by(Recipient.name, Recipient.created_at)

        print(f"DEBUG: About to execute query...")
        print(f"DEBUG: Query: {query}")

        recipients = query.all()

        print(f"DEBUG: Queried {len(recipients)} recipients from database")
        if len(recipients) > 0:
            print(f"DEBUG: First recipient: ID={recipients[0].id}, name={recipients[0].name}")
        if len(recipients) > 1:
            print(f"DEBUG: Second recipient: ID={recipients[1].id}, name={recipients[1].name}")
        if len(recipients) > 2:
            print(f"DEBUG: Third recipient: ID={recipients[2].id}, name={recipients[2].name}")

        # Group recipients by name first
        grouped_by_name: Dict[str, List[RecipientInfo]] = defaultdict(list)
        for r in recipients:
            # Get planned transaction count separately
            planned_count = (
                                self.db.query(func.count(PlannedTransaction.id))
                                .filter(PlannedTransaction.recipient_id == r.id)
                                .scalar()
                            ) or 0

            recipient_info = RecipientInfo(
                id=r.id,
                name=r.name,
                account_number=r.account_number,
                default_category_id=r.default_category_id,
                notes=r.notes,
                address=r.address,
                is_active=r.is_active,
                transaction_count=r.transaction_count,
                planned_transaction_count=planned_count,
                created_at=r.created_at
            )
            grouped_by_name[r.name].append(recipient_info)

        print(f"DEBUG: Found {len(grouped_by_name)} unique recipient names")

        # Count names with duplicates
        names_with_dups = {n: rs for n, rs in grouped_by_name.items() if len(rs) > 1}
        print(f"DEBUG: {len(names_with_dups)} names have multiple recipients")

        if names_with_dups:
            first_5 = list(names_with_dups.items())[:5]
            print(f"DEBUG: First 5 duplicate names:")
            for name, recs in first_5:
                print(f"  - {name}: {len(recs)} recipients")

        # Create merge groups based on name and account_number compatibility
        merge_groups = []
        for name, recipient_list in grouped_by_name.items():
            if len(recipient_list) <= 1:
                continue

            # Group recipients by compatible account numbers
            # Key: account_number or 'MERGEABLE' for NULLs
            account_groups: Dict[str, List[RecipientInfo]] = defaultdict(list)

            for recipient in recipient_list:
                if recipient.account_number:
                    # Has account number - group by exact match
                    account_groups[recipient.account_number].append(recipient)
                else:
                    # NULL account number - can merge with any group of same name
                    account_groups['MERGEABLE_NULL'].append(recipient)

            print(
                f"DEBUG: Processing '{name}' with {len(recipient_list)} recipients into {len(account_groups)} account groups")
            for acct_key, group in account_groups.items():
                print(f"  - Account '{acct_key[:30] if len(acct_key) > 30 else acct_key}': {len(group)} recipients")

            # Process each account group
            for account_key, recipients_in_group in account_groups.items():
                if account_key == 'MERGEABLE_NULL':
                    # NULLs can only merge with each other (same name, all NULL accounts)
                    if len(recipients_in_group) > 1:
                        print(
                            f"DEBUG: Creating merge group for '{name}' (NULL accounts): {len(recipients_in_group)} recipients")
                        merge_group = MergeGroup(
                            name=name,
                            recipients=recipients_in_group,
                            category_ids=set(),
                            has_category_conflict=False,
                            total_transactions=0,
                            total_planned_transactions=0
                        )
                        merge_groups.append(merge_group)
                        if merge_group.has_category_conflict:
                            self.category_conflicts.append(merge_group)
                else:
                    # Same name AND same account number - should merge
                    if len(recipients_in_group) > 1:
                        print(
                            f"DEBUG: Creating merge group for '{name}' (account={account_key[:30]}): {len(recipients_in_group)} recipients")
                        merge_group = MergeGroup(
                            name=name,
                            recipients=recipients_in_group,
                            category_ids=set(),
                            has_category_conflict=False,
                            total_transactions=0,
                            total_planned_transactions=0
                        )
                        merge_groups.append(merge_group)
                        if merge_group.has_category_conflict:
                            self.category_conflicts.append(merge_group)

        self.merge_groups = sorted(merge_groups, key=lambda g: g.total_transactions, reverse=True)

        print(f"DEBUG: Total merge groups created: {len(self.merge_groups)}")
        print(f"DEBUG: Total category conflicts: {len(self.category_conflicts)}")

        logger.info(f"Found {len(self.merge_groups)} groups of duplicates")
        logger.info(f"Found {len(self.category_conflicts)} groups with category conflicts")

        return self.merge_groups

    def _select_primary_recipient(self, recipients: List[RecipientInfo]) -> RecipientInfo:
        """
        Select the primary recipient to keep when merging.

        Selection criteria (in order):
        1. Recipient with the most transaction history
        2. Recipient with complete information (address, notes, category)
        3. Oldest recipient (by creation date)

        Args:
            recipients: List of duplicate recipients

        Returns:
            The recipient to keep as primary
        """

        # Score each recipient
        def score_recipient(r: RecipientInfo) -> tuple:
            completeness = sum([
                bool(r.address),
                bool(r.notes),
                bool(r.account_number),
                bool(r.default_category_id),
            ])
            return (
                r.transaction_count + r.planned_transaction_count,
                completeness,
                -r.created_at.timestamp()  # Negative for oldest first
            )

        return max(recipients, key=score_recipient)

    def _merge_recipient_data(self, primary: RecipientInfo, others: List[RecipientInfo]) -> Dict[str, any]:
        """
        Merge data from duplicate recipients into the primary recipient.

        Merging strategy:
        - Keep primary's data if not null
        - Otherwise, take first non-null value from others
        - Combine notes from all recipients

        Args:
            primary: The primary recipient to update
            others: Other recipients to merge from

        Returns:
            Dictionary of fields to update on the primary recipient
        """
        updates = {}

        # Merge address (keep primary if exists, otherwise first non-null)
        if not primary.address:
            for other in others:
                if other.address:
                    updates['address'] = other.address
                    break

        # Merge account_number (keep primary if exists, otherwise first non-null)
        if not primary.account_number:
            for other in others:
                if other.account_number:
                    updates['account_number'] = other.account_number
                    break

        # Merge notes (combine all non-empty notes)
        all_notes = []
        if primary.notes:
            all_notes.append(primary.notes)
        for other in others:
            if other.notes and other.notes not in all_notes:
                all_notes.append(other.notes)
        if len(all_notes) > 1 or (len(all_notes) == 1 and not primary.notes):
            updates['notes'] = " | ".join(all_notes)

        # Merge default_category_id (keep primary if exists, otherwise first non-null)
        if not primary.default_category_id:
            for other in others:
                if other.default_category_id:
                    updates['default_category_id'] = other.default_category_id
                    break

        return updates

    def merge_group(self, merge_group: MergeGroup) -> Optional[int]:
        """
        Merge a group of duplicate recipients.

        Args:
            merge_group: Group of duplicates to merge

        Returns:
            ID of the primary recipient, or None if dry-run
        """
        recipients = merge_group.recipients
        primary = self._select_primary_recipient(recipients)
        others = [r for r in recipients if r.id != primary.id]

        logger.info(f"\n{'=' * 80}")
        logger.info(f"Merging recipients for: {merge_group.name}")
        logger.info(f"Primary recipient: ID={primary.id}, acct={primary.account_number or 'NULL'} "
                    f"(transactions: {primary.transaction_count}, planned: {primary.planned_transaction_count})")
        logger.info(f"Merging from IDs: {[r.id for r in others]}")
        for other in others:
            logger.info(f"  - ID {other.id}: acct={other.account_number or 'NULL'}, "
                        f"txns={other.transaction_count}, planned={other.planned_transaction_count}")

        # Show category conflict warning
        if merge_group.has_category_conflict:
            logger.warning(f"⚠️  CATEGORY CONFLICT DETECTED!")
            for r in recipients:
                logger.warning(f"   Recipient ID {r.id}: category_id = {r.default_category_id}")

        # Get merged data
        updates = self._merge_recipient_data(primary, others)

        if updates:
            logger.info(f"Fields to update on primary: {list(updates.keys())}")
            for key, value in updates.items():
                logger.info(f"  {key}: {value}")

        # Count transactions to update
        other_ids = [r.id for r in others]
        transaction_update_count = (
                                       self.db.query(func.count(Transaction.id))
                                       .filter(Transaction.recipient_id.in_(other_ids))
                                       .scalar()
                                   ) or 0

        planned_transaction_update_count = (
                                               self.db.query(func.count(PlannedTransaction.id))
                                               .filter(PlannedTransaction.recipient_id.in_(other_ids))
                                               .scalar()
                                           ) or 0

        logger.info(f"Transactions to reassign: {transaction_update_count}")
        logger.info(f"Planned transactions to reassign: {planned_transaction_update_count}")

        if self.dry_run:
            logger.info("🔍 DRY RUN: No changes made to database")
            return None

        # Execute merge
        try:
            # Update primary recipient with merged data
            if updates:
                primary_db = self.db.query(Recipient).filter(Recipient.id == primary.id).first()
                for key, value in updates.items():
                    setattr(primary_db, key, value)

            # Reassign all transactions
            if transaction_update_count > 0:
                self.db.query(Transaction).filter(
                    Transaction.recipient_id.in_(other_ids)
                ).update(
                    {Transaction.recipient_id: primary.id},
                    synchronize_session=False
                )

            # Reassign all planned transactions
            if planned_transaction_update_count > 0:
                self.db.query(PlannedTransaction).filter(
                    PlannedTransaction.recipient_id.in_(other_ids)
                ).update(
                    {PlannedTransaction.recipient_id: primary.id},
                    synchronize_session=False
                )

            # Soft-delete duplicate recipients
            self.db.query(Recipient).filter(
                Recipient.id.in_(other_ids)
            ).update(
                {Recipient.is_active: False},
                synchronize_session=False
            )

            self.db.commit()
            logger.info(f"✅ Successfully merged into recipient ID {primary.id}")
            return primary.id

        except Exception as e:
            self.db.rollback()
            logger.error(f"❌ Error merging recipients: {e}")
            raise

    def execute_all_merges(self, skip_conflicts: bool = True) -> Dict[str, int]:
        """
        Execute all merges for found duplicates.

        Args:
            skip_conflicts: If True, skip groups with category conflicts

        Returns:
            Statistics about the merge operation
        """
        stats = {
            'groups_processed': 0,
            'recipients_merged': 0,
            'transactions_reassigned': 0,
            'planned_transactions_reassigned': 0,
            'category_conflicts': 0,
            'conflicts_skipped': 0,
        }

        for merge_group in self.merge_groups:
            if merge_group.has_category_conflict:
                stats['category_conflicts'] += 1
                if skip_conflicts:
                    logger.info(f"\n⏭️  SKIPPING merge for '{merge_group.name}' due to category conflict")
                    stats['conflicts_skipped'] += 1
                    continue

            self.merge_group(merge_group)

            stats['groups_processed'] += 1
            stats['recipients_merged'] += len(merge_group.recipients) - 1
            stats['transactions_reassigned'] += merge_group.total_transactions
            stats['planned_transactions_reassigned'] += merge_group.total_planned_transactions

        return stats

    def print_summary(self):
        """Print a summary of all merge groups."""
        logger.info("\n" + "=" * 80)
        logger.info("MERGE SUMMARY")
        logger.info("=" * 80)

        if not self.merge_groups:
            logger.info("No duplicate recipients found.")
            return

        logger.info(f"\nTotal duplicate groups: {len(self.merge_groups)}")
        logger.info(f"Groups with category conflicts: {len(self.category_conflicts)}")

        # Show top duplicates by transaction count
        logger.info("\n--- Top 20 Duplicate Groups by Transaction Count ---")
        for i, group in enumerate(self.merge_groups[:20], 1):
            conflict_marker = "⚠️ " if group.has_category_conflict else ""
            logger.info(f"{i:2d}. {conflict_marker}{group.name}")
            logger.info(f"    Duplicates: {len(group.recipients)} recipients")

            # Show recipient details
            for r in group.recipients:
                acct_display = f"acct={r.account_number}" if r.account_number else "acct=NULL"
                logger.info(
                    f"       ID {r.id:3d}: {acct_display}, txns={r.transaction_count:4d}, cat={r.default_category_id or 'None'}")

            logger.info(f"    Total Transactions: {group.total_transactions}")
            logger.info(f"    Total Planned: {group.total_planned_transactions}")
            logger.info(f"    Category IDs: {sorted([cid for cid in group.category_ids if cid is not None])}")

        # Show all category conflicts
        if self.category_conflicts:
            logger.info("\n" + "=" * 80)
            logger.info("⚠️  CATEGORY CONFLICTS DETECTED")
            logger.info("=" * 80)
            logger.info(f"\nThe following {len(self.category_conflicts)} recipient groups have different category IDs:")

            for i, group in enumerate(self.category_conflicts, 1):
                logger.info(f"\n{i}. {group.name}")
                for r in group.recipients:
                    acct_display = f"acct={r.account_number[:20]}..." if r.account_number and len(
                        r.account_number) > 20 else f"acct={r.account_number or 'NULL'}"
                    logger.info(f"   ID {r.id:3d}: {acct_display}, "
                                f"category_id={r.default_category_id or 'None':>3}, "
                                f"transactions={r.transaction_count:4d}, "
                                f"created={r.created_at.strftime('%Y-%m-%d')}")


def main():
    """Main entry point for the merge script."""

    print("=" * 80)
    print("RECIPIENT MERGE UTILITY - STARTING")
    print("=" * 80)
    print(f"Database: {HARDCODED_DATABASE_URL}")
    print("=" * 80)

    parser = argparse.ArgumentParser(
        description="Merge duplicate recipients in the financial transactions database",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Preview all merges without making changes
  python -m utils.merge_recipients --dry-run

  # Execute all merges
  python -m utils.merge_recipients

  # Preview merge for a specific recipient
  python -m utils.merge_recipients --dry-run --name "IBE BRICHAU"

  # Execute merge for a specific recipient
  python -m utils.merge_recipients --name "IBE BRICHAU"
        """
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without modifying the database'
    )
    parser.add_argument(
        '--name',
        type=str,
        help='Only merge duplicates for the specified recipient name'
    )
    parser.add_argument(
        '--include-conflicts',
        action='store_true',
        help='Include merges with category conflicts (default: skip conflicts)'
    )

    args = parser.parse_args()

    # Create engine with hardcoded database URL
    engine = create_engine(
        HARDCODED_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )

    # Create session factory
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    # Initialize database session
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    try:
        # Show database information
        print(f"\nDatabase engine: {engine.url}")
        if str(engine.url).startswith("sqlite:///"):
            db_file = str(engine.url).replace("sqlite:///", "")
            import os
            if os.path.exists(db_file):
                file_size = os.path.getsize(db_file)
                print(f"Database file size: {file_size:,} bytes ({file_size / 1024 / 1024:.2f} MB)")
            else:
                print("⚠️  WARNING: Database file does not exist!")

        # Quick count to verify connection
        total_recipients = db.query(Recipient).count()
        active_recipients = db.query(Recipient).filter(Recipient.is_active == True).count()
        print(f"Total recipients in database: {total_recipients} (active: {active_recipients})")
        print("")

        logger.info("=" * 80)
        logger.info("RECIPIENT MERGE UTILITY")
        logger.info("=" * 80)
        logger.info(f"Mode: {'DRY RUN (preview only)' if args.dry_run else 'LIVE (will modify database)'}")
        if args.name:
            logger.info(f"Filter: Only processing recipient '{args.name}'")
        logger.info("")

        # Create merger and find duplicates
        merger = RecipientMerger(db, dry_run=args.dry_run)
        merger.find_duplicates(specific_name=args.name)

        # Print summary
        merger.print_summary()

        if not merger.merge_groups:
            logger.info("\nNo duplicates to merge. Exiting.")
            return 0

        # Calculate what will be processed
        skip_conflicts = not args.include_conflicts
        groups_to_process = [g for g in merger.merge_groups if not (skip_conflicts and g.has_category_conflict)]
        groups_to_skip = [g for g in merger.merge_groups if skip_conflicts and g.has_category_conflict]

        logger.info("\n" + "=" * 80)
        logger.info("MERGE PLAN")
        logger.info("=" * 80)
        logger.info(f"Total merge groups found: {len(merger.merge_groups)}")
        logger.info(f"Groups without conflicts: {len(groups_to_process)}")
        if groups_to_skip:
            logger.info(f"Groups with conflicts (will be SKIPPED): {len(groups_to_skip)}")
            logger.info(f"  Strategy: Merge non-conflicting recipients first")
            logger.info(f"  Use --include-conflicts to merge conflicting groups too")

        # Ask for confirmation if not dry-run
        if not args.dry_run:
            logger.info("\n" + "=" * 80)
            logger.warning("⚠️  WARNING: This will modify the database!")
            logger.info("=" * 80)
            if groups_to_skip:
                logger.info(f"\n✓ Will merge {len(groups_to_process)} groups WITHOUT category conflicts")
                logger.info(f"⏭️  Will skip {len(groups_to_skip)} groups WITH category conflicts")
            response = input("\nProceed with merge? (yes/no): ").strip().lower()
            if response not in ('yes', 'y'):
                logger.info("Merge cancelled by user.")
                return 0

        # Execute merges
        logger.info("\n" + "=" * 80)
        logger.info("EXECUTING MERGES")
        logger.info("=" * 80)

        stats = merger.execute_all_merges(skip_conflicts=skip_conflicts)

        # Print final statistics
        logger.info("\n" + "=" * 80)
        logger.info("MERGE COMPLETE")
        logger.info("=" * 80)
        logger.info(f"Groups processed: {stats['groups_processed']}")
        logger.info(f"Groups skipped (conflicts): {stats['conflicts_skipped']}")
        logger.info(f"Recipients merged: {stats['recipients_merged']}")
        logger.info(f"Transactions reassigned: {stats['transactions_reassigned']}")
        logger.info(f"Planned transactions reassigned: {stats['planned_transactions_reassigned']}")
        logger.info(f"Category conflicts encountered: {stats['category_conflicts']}")

        if stats['conflicts_skipped'] > 0:
            logger.info("\n" + "=" * 80)
            logger.info("⚠️  SKIPPED GROUPS (CATEGORY CONFLICTS)")
            logger.info("=" * 80)
            logger.info(f"\n{stats['conflicts_skipped']} groups were skipped due to category conflicts.")
            logger.info("These require manual review to determine the correct category.")
            logger.info("\nTo merge these groups, review the category conflicts in the summary above,")
            logger.info("update the categories manually in the database, then run the script again.")
            logger.info("\nOr use --include-conflicts flag to merge them anyway (uses primary recipient's category).")

        if args.dry_run:
            logger.info("\n🔍 This was a DRY RUN - no changes were made to the database.")
            logger.info("Run without --dry-run to execute the merge.")

        return 0

    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        return 1

    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
