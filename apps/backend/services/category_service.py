"""
Category Management Service

Handles hierarchical categories with General:Detailed format
"""
import csv
from typing import Dict, List, Optional, Tuple, Any

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
