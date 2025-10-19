"""
Category Management Service

Handles hierarchical categories with General:Detailed format
"""
import csv
from typing import Dict, List, Optional, Tuple, Any, Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from database.models import Category, Recipient, Transaction


class CategoryService:
    """Service for managing hierarchical categories"""

    def __init__(self, db_session: Session):
        self.db = db_session

    def parse_category_path(self, category_path: str) -> Tuple[str, Optional[str]]:
        """
        Parse category path in format "General:Detailed"
        Returns: (general, detailed) where detailed can be None
        """
        if ':' in category_path:
            parts = category_path.split(':', 1)
            return parts[0].strip(), parts[1].strip()
        else:
            return category_path.strip(), None

    def get_or_create_category(
            self,
            category_path: str,
            description: Optional[str] = None,
            color: Optional[str] = None
    ) -> Category:
        """
        Get or create a category from path like "Food:Meat"
        Creates both parent (General) and child (Detailed) if needed
        """
        general_name, detailed_name = self.parse_category_path(category_path)

        if detailed_name:
            # Create/get general category first
            general_category = self._get_or_create_general_category(general_name)

            # Create/get detailed category
            full_path = f"{general_name}:{detailed_name}"
            detailed_category = self.db.query(Category).filter(
                Category.full_path == full_path
            ).first()

            if not detailed_category:
                detailed_category = Category(
                    name=detailed_name,
                    full_path=full_path,
                    general=general_name,
                    detail=detailed_name,
                    parent_id=general_category.id,
                    category_type='detailed',
                    description=description,
                    color=color,
                    is_active=True
                )
                self.db.add(detailed_category)
                self.db.commit()
                self.db.refresh(detailed_category)

            return detailed_category
        else:
            # Just a general category
            return self._get_or_create_general_category(general_name, description, color)

    def _get_or_create_general_category(
            self,
            name: str,
            description: Optional[str] = None,
            color: Optional[str] = None
    ) -> Category:
        """Get or create a general (parent) category"""
        category = self.db.query(Category).filter(
            Category.full_path == name,
            Category.category_type == 'general'
        ).first()

        if not category:
            category = Category(
                name=name,
                full_path=name,
                general=name,
                detail=None,
                parent_id=None,
                category_type='general',
                description=description,
                color=color,
                is_active=True
            )
            self.db.add(category)
            self.db.commit()
            self.db.refresh(category)

        return category

    def import_category_mappings_from_csv(
            self,
            file_path: str,
            recipient_column: str = 'Recipient',
            category_column: str = 'Category',
            has_header: bool = True
    ) -> Dict[str, Any]:
        """
        Import category mappings from CSV file

        Expected format:
        Recipient,Category
        "John Doe","Food:Groceries"
        "Acme Corp","Business:Supplies"

        Returns statistics about the import
        """
        results = {
            'total_processed': 0,
            'mappings_created': 0,
            'categories_created': 0,
            'recipients_not_found': [],
            'errors': []
        }

        try:
            with open(file_path, 'r', encoding='utf-8') as csvfile:
                reader = csv.DictReader(csvfile) if has_header else csv.reader(csvfile)

                for row in reader:
                    results['total_processed'] += 1

                    try:
                        if has_header:
                            recipient_name = row[recipient_column].strip()
                            category_path = row[category_column].strip()
                        else:
                            recipient_name = row[0].strip()
                            category_path = row[1].strip()

                        if not recipient_name or not category_path:
                            continue

                        # Find recipient
                        recipient = self.db.query(Recipient).filter(
                            Recipient.name == recipient_name
                        ).first()

                        if not recipient:
                            results['recipients_not_found'].append(recipient_name)
                            continue

                        # Get or create category
                        category = self.get_or_create_category(category_path)

                        if not recipient.default_category_id:
                            results['categories_created'] += 1

                        # Assign category to recipient
                        recipient.default_category_id = category.id
                        results['mappings_created'] += 1

                    except Exception as e:
                        results['errors'].append(f"Row {results['total_processed']}: {str(e)}")

                self.db.commit()

        except Exception as e:
            results['errors'].append(f"Fatal error: {str(e)}")
            self.db.rollback()

        return results

    def import_recipient_categories_from_activity_csv(
            self,
            files: Iterable[str],
            recipient_columns: Iterable[str] = ("Recipient", "Payee", "Description"),
            category_columns: Iterable[str] = ("Category",),
            delimiter_candidates: Iterable[str] = (",", ";", "\t"),
            create_missing_recipients: bool = True,
            apply_to_existing_transactions: bool = False
    ) -> Dict[str, Any]:
        """
        Aggregate recipient->category mappings from one or more transaction/activity CSV files
        that include a recipient and a category column (e.g., "Date, Check, Recipient, Category, ...").

        Logic:
        - For each file, detect a supported delimiter and map header columns case-insensitively.
        - Tally categories per normalized recipient name.
        - Choose the most common category for each recipient (ties broken by lexicographic order of full_path).
        - Create categories as needed using the existing hierarchical structure (General:Detailed).
        - Update recipients' default_category_id; create recipients if allowed and missing.
        - Optionally apply default recipient categories to existing transactions without a category.

        Returns stats including files processed, recipients updated/created, and any errors.
        """

        # Helper: normalize strings for matching keys
        def _norm(s: str) -> str:
            return (s or '').strip().lower()

        # Map of norm_recipient -> { 'display_name': most common casing, 'categories': {path: count} }
        tallies: Dict[str, Dict[str, Any]] = {}
        stats = {
            'files_processed': 0,
            'rows_read': 0,
            'recipients_considered': 0,
            'recipients_updated': 0,
            'recipients_created': 0,
            'categories_created': 0,
            'skipped_files': [],
            'errors': []
        }

        # Build lowercase lookup sets for header matching
        rcands = [c.lower() for c in recipient_columns]
        ccands = [c.lower() for c in category_columns]

        for path in files:
            try:
                # Try each delimiter until headers can be matched
                header = None
                reader = None
                file_obj = None
                used_delim = None

                for delim in delimiter_candidates:
                    try:
                        file_obj = open(path, 'r', encoding='utf-8')
                        reader = csv.DictReader(file_obj, delimiter=delim)
                        header = [h.strip() for h in (reader.fieldnames or [])]
                        if not header:
                            file_obj.close()
                            continue
                        lower = [h.lower() for h in header]
                        if any(h in lower for h in rcands) and any(h in lower for h in ccands):
                            used_delim = delim
                            break
                        file_obj.close()
                        file_obj = None
                        reader = None
                    except Exception:
                        if file_obj:
                            file_obj.close()
                        reader = None
                        continue

                if reader is None or header is None or used_delim is None:
                    stats['skipped_files'].append({'file': path, 'reason': 'No suitable delimiter or headers'})
                    continue

                # Identify actual column names
                lower = [h.lower() for h in header]
                try:
                    r_idx = next(i for i, h in enumerate(lower) if h in rcands)
                    c_idx = next(i for i, h in enumerate(lower) if h in ccands)
                except StopIteration:
                    stats['skipped_files'].append({'file': path, 'reason': 'Missing Recipient or Category header'})
                    file_obj.close()
                    continue

                recipient_col = header[r_idx]
                category_col = header[c_idx]

                # Read rows
                for row in reader:
                    stats['rows_read'] += 1
                    try:
                        recipient_name = (row.get(recipient_col) or '').strip()
                        category_path = (row.get(category_col) or '').strip()
                        if not recipient_name or not category_path:
                            continue

                        nkey = _norm(recipient_name)
                        entry = tallies.setdefault(nkey, {'display_name_counts': {}, 'categories': {}})
                        # Track most common display name casing
                        d_counts = entry['display_name_counts']
                        d_counts[recipient_name] = d_counts.get(recipient_name, 0) + 1
                        # Tally category
                        cats = entry['categories']
                        cats[category_path] = cats.get(category_path, 0) + 1
                    except Exception as e:
                        stats['errors'].append(f"{path}: row error: {e}")
                        continue

                file_obj.close()
                stats['files_processed'] += 1

            except Exception as e:
                stats['errors'].append(f"{path}: {e}")
                try:
                    if file_obj:
                        file_obj.close()
                except Exception:
                    pass
                continue

        # Apply tallied mappings
        stats['recipients_considered'] = len(tallies)
        for nkey, data in tallies.items():
            # Choose display name with highest count; tie -> longest then lexicographic
            display_name = max(
                data['display_name_counts'].items(),
                key=lambda kv: (kv[1], len(kv[0]), kv[0])
            )[0]
            # Choose category with highest count; tie -> lexicographic of path
            category_path = max(
                data['categories'].items(),
                key=lambda kv: (kv[1], kv[0])
            )[0]

            # Ensure category exists
            # Count created by checking pre-existence first
            general, detailed = self.parse_category_path(category_path)
            pre_general = self.db.query(Category).filter(Category.full_path == general).first()
            pre_full = self.db.query(Category).filter(Category.full_path == category_path).first()
            category = self.get_or_create_category(category_path)
            if not pre_full and (detailed is not None):
                stats['categories_created'] += 1
            elif not pre_general and (detailed is None):
                stats['categories_created'] += 1

            # Find or create recipient (case-insensitive exact match)
            recipient = self.db.query(Recipient).filter(func.lower(Recipient.name) == func.lower(display_name)).first()
            if not recipient:
                if not create_missing_recipients:
                    continue
                recipient = Recipient(name=display_name)
                self.db.add(recipient)
                self.db.flush()
                stats['recipients_created'] += 1

            # Update default category if different
            if recipient.default_category_id != category.id:
                recipient.default_category_id = category.id
                stats['recipients_updated'] += 1

        self.db.commit()

        # Optionally apply to transactions
        if apply_to_existing_transactions:
            apply_stats = self.apply_recipient_categories_to_transactions(overwrite_existing=False)
            stats['applied_to_transactions'] = apply_stats

        return stats

    def apply_recipient_categories_to_transactions(
            self,
            recipient_id: Optional[int] = None,
            overwrite_existing: bool = False
    ) -> Dict[str, int]:
        """
        Apply default recipient categories to transactions

        Args:
            recipient_id: If specified, only update transactions for this recipient
            overwrite_existing: If True, overwrite transactions that already have categories

        Returns:
            Dictionary with update statistics
        """
        query = self.db.query(Transaction).join(Recipient)

        if recipient_id:
            query = query.filter(Recipient.id == recipient_id)

        if not overwrite_existing:
            query = query.filter(Transaction.category_id.is_(None))

        # Only update where recipient has a default category
        query = query.filter(Recipient.default_category_id.isnot(None))

        transactions = query.all()

        updated = 0
        for transaction in transactions:
            transaction.category_id = transaction.recipient.default_category_id
            updated += 1

        self.db.commit()

        return {
            'updated': updated,
            'total_checked': len(transactions)
        }

    def get_all_categories_hierarchical(self) -> List[Dict[str, Any]]:
        """Get all categories in hierarchical structure"""
        # Get all general categories
        general_categories = self.db.query(Category).filter(
            Category.category_type == 'general',
            Category.is_active == True
        ).order_by(Category.name).all()

        result = []
        for general in general_categories:
            general_dict = {
                'id': general.id,
                'name': general.name,
                'full_path': general.full_path,
                'type': 'general',
                'description': general.description,
                'color': general.color,
                'transaction_count': len(general.transactions),
                'children': []
            }

            # Get detailed categories
            for detailed in general.children:
                if detailed.is_active:
                    general_dict['children'].append({
                        'id': detailed.id,
                        'name': detailed.name,
                        'full_path': detailed.full_path,
                        'type': 'detailed',
                        'description': detailed.description,
                        'color': detailed.color,
                        'transaction_count': len(detailed.transactions)
                    })

            result.append(general_dict)

        return result

    def get_category_by_path(self, path: str) -> Optional[Category]:
        """Get category by full path (e.g., 'Food:Meat')"""
        return self.db.query(Category).filter(Category.full_path == path).first()

    def get_uncategorized_recipients(self) -> List[Recipient]:
        """Get all recipients without a default category"""
        return self.db.query(Recipient).filter(
            Recipient.default_category_id.is_(None),
            Recipient.is_active == True
        ).all()

    def get_uncategorized_transactions(self, limit: int = 100) -> List[Transaction]:
        """Get transactions without categories"""
        return self.db.query(Transaction).filter(
            Transaction.category_id.is_(None)
        ).order_by(Transaction.date.desc()).limit(limit).all()

    def get_category_statistics(self) -> Dict[str, Any]:
        """Get statistics about categories"""
        total_categories = self.db.query(func.count(Category.id)).scalar()
        general_count = self.db.query(func.count(Category.id)).filter(
            Category.category_type == 'general'
        ).scalar()
        detailed_count = self.db.query(func.count(Category.id)).filter(
            Category.category_type == 'detailed'
        ).scalar()

        categorized_transactions = self.db.query(func.count(Transaction.id)).filter(
            Transaction.category_id.isnot(None)
        ).scalar()

        uncategorized_transactions = self.db.query(func.count(Transaction.id)).filter(
            Transaction.category_id.is_(None)
        ).scalar()

        categorized_recipients = self.db.query(func.count(Recipient.id)).filter(
            Recipient.default_category_id.isnot(None)
        ).scalar()

        uncategorized_recipients = self.db.query(func.count(Recipient.id)).filter(
            Recipient.default_category_id.is_(None)
        ).scalar()

        return {
            'total_categories': total_categories,
            'general_categories': general_count,
            'detailed_categories': detailed_count,
            'categorized_transactions': categorized_transactions,
            'uncategorized_transactions': uncategorized_transactions,
            'categorized_recipients': categorized_recipients,
            'uncategorized_recipients': uncategorized_recipients
        }

    def suggest_category_for_recipient(self, recipient_name: str) -> Optional[str]:
        """
        Suggest a category for a recipient based on similar recipients
        Uses simple name matching
        """
        # Find recipients with similar names that have categories
        similar_recipients = self.db.query(Recipient).filter(
            Recipient.name.ilike(f"%{recipient_name}%"),
            Recipient.default_category_id.isnot(None)
        ).limit(5).all()

        if not similar_recipients:
            return None

        # Count category occurrences
        category_counts: Dict[str, int] = {}
        for recipient in similar_recipients:
            if recipient.default_category:
                path = recipient.default_category.full_path
                category_counts[path] = category_counts.get(path, 0) + 1

        # Return most common
        if category_counts:
            return max(category_counts.items(), key=lambda x: x[1])[0]

        return None

    def bulk_assign_category(
            self,
            recipient_ids: List[int],
            category_path: str
    ) -> Dict[str, int]:
        """
        Assign a category to multiple recipients at once
        """
        category = self.get_or_create_category(category_path)

        updated = 0
        for recipient_id in recipient_ids:
            recipient = self.db.query(Recipient).filter(Recipient.id == recipient_id).first()
            if recipient:
                recipient.default_category_id = category.id
                updated += 1

        self.db.commit()
        return {'updated': updated}

    def export_category_mappings_to_csv(
            self,
            file_path: str,
            include_uncategorized: bool = False
    ) -> Dict[str, Any]:
        """
        Export recipient-to-category mappings to CSV
        """
        try:
            with open(file_path, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile)
                writer.writerow(['Recipient', 'Category', 'Transaction Count'])

                query = self.db.query(Recipient)
                if not include_uncategorized:
                    query = query.filter(Recipient.default_category_id.isnot(None))

                recipients = query.order_by(Recipient.name).all()

                for recipient in recipients:
                    category_path = recipient.default_category.full_path if recipient.default_category else ''
                    txn_count = len(recipient.transactions)
                    writer.writerow([recipient.name, category_path, txn_count])

            return {
                'success': True,
                'count': len(recipients),
                'file_path': file_path
            }

        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
