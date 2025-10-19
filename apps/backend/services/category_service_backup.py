"""
Category Management Service

Handles hierarchical categories with General:Detailed format
"""
import csv
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from database.models import Category, Recipient, Transaction, RecipientCategoryMapping


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
            Category.name == name,
            Category.parent_id == None
        ).first()

        if not category:
            category = Category(
                name=name,
                parent_id=None,
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

        # Count top-level (parent) categories
        general_count = self.db.query(func.count(Category.id)).filter(
            Category.parent_id == None
        ).scalar()

        # Count child (detailed) categories
        detailed_count = self.db.query(func.count(Category.id)).filter(
            Category.parent_id.isnot(None)
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
                    if recipient.default_category:
                        # Build category path
                        if recipient.default_category.parent_id:
                            parent = self.db.query(Category).filter(
                                Category.id == recipient.default_category.parent_id
                            ).first()
                            category_path = f"{parent.name}:{recipient.default_category.name}" if parent else recipient.default_category.name
                        else:
                            category_path = recipient.default_category.name
                    else:
                        category_path = ''

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

    def parse_category_detail(self, category_string: str) -> Tuple[str, Optional[str]]:
        """
        Parse a category string in the format 'CATEGORY:DETAIL' or 'CATEGORY'
        Returns: (category, detail)
        """
        if not category_string:
            return ("Uncategorized", None)

        parts = category_string.split(":", 1)
        category = parts[0].strip()
        detail = parts[1].strip() if len(parts) > 1 else None
        return (category, detail)

    def get_or_create_recipient(self, name: str, iban: Optional[str] = None) -> Recipient:
        """Get or create a recipient by name and optionally IBAN"""
        # Try to find by IBAN first if provided
        if iban:
            recipient = self.db.query(Recipient).filter(
                Recipient.account_number == iban
            ).first()
            if recipient:
                return recipient

        # Try to find by name
        recipient = self.db.query(Recipient).filter(
            Recipient.name == name
        ).first()

        if not recipient:
            recipient = Recipient(
                name=name,
                account_number=iban,
                is_active=True
            )
            self.db.add(recipient)
            self.db.flush()
        elif iban and not recipient.account_number:
            # Update recipient with IBAN if we found by name but didn't have IBAN
            recipient.account_number = iban
            self.db.flush()

        return recipient

    def add_recipient_category_mapping(
            self,
            recipient: Recipient,
            category_name: str,
            detail_name: Optional[str] = None,
            priority: int = 0,
            confidence: int = 100
    ) -> RecipientCategoryMapping:
        """
        Add or update a category mapping for a recipient
        """
        # Check if mapping already exists
        existing = self.db.query(RecipientCategoryMapping).filter(
            RecipientCategoryMapping.recipient_id == recipient.id,
            RecipientCategoryMapping.category_name == category_name,
            RecipientCategoryMapping.detail_name == detail_name
        ).first()

        if existing:
            # Update existing mapping
            existing.priority = max(existing.priority, priority)
            existing.confidence = max(existing.confidence, confidence)
            existing.is_active = True
            existing.updated_at = datetime.utcnow()
            return existing

        # Create new mapping
        mapping = RecipientCategoryMapping(
            recipient_id=recipient.id,
            category_name=category_name,
            detail_name=detail_name,
            priority=priority,
            confidence=confidence,
            is_active=True
        )
        self.db.add(mapping)
        self.db.flush()

        return mapping

    def get_recipient_mappings(self, recipient_id: int) -> List[RecipientCategoryMapping]:
        """Get all category mappings for a recipient"""
        return self.db.query(RecipientCategoryMapping).filter(
            RecipientCategoryMapping.recipient_id == recipient_id,
            RecipientCategoryMapping.is_active == True
        ).order_by(RecipientCategoryMapping.priority.desc()).all()

    def get_best_category_for_recipient(
            self, recipient_id: int
    ) -> Optional[Tuple[str, Optional[str]]]:
        """
        Get the best category mapping for a recipient based on priority
        Returns: (category_name, detail_name) or None
        """
        mappings = self.get_recipient_mappings(recipient_id)
        if mappings:
            best = mappings[0]
            return (best.category_name, best.detail_name)
        return None

    def import_category_mapping(
            self,
            recipient_name: str,
            category_string: str,
            iban: Optional[str] = None,
            priority: int = 0
    ) -> Dict[str, any]:
        """
        Import a single category mapping from CSV data
        Returns: dict with status and created objects
        """
        # Parse category:detail
        category_name, detail_name = self.parse_category_detail(category_string)

        # Get or create recipient
        recipient = self.get_or_create_recipient(recipient_name, iban)

        # Create categories - use the full path method
        if detail_name:
            full_path = f"{category_name}:{detail_name}"
            category = self.get_or_create_category(full_path)
        else:
            category = self.get_or_create_category(category_name)

        # Add mapping
        mapping = self.add_recipient_category_mapping(
            recipient,
            category_name,
            detail_name,
            priority=priority
        )

        return {
            "recipient": recipient,
            "category": category_name,
            "detail": detail_name,
            "mapping": mapping
        }

    def get_all_recipients_with_mappings(self) -> List[Dict]:
        """Get all recipients with their category mappings"""
        recipients = self.db.query(Recipient).filter(
            Recipient.is_active == True
        ).all()

        result = []
        for recipient in recipients:
            mappings = self.get_recipient_mappings(recipient.id)
            result.append({
                "id": recipient.id,
                "name": recipient.name,
                "iban": recipient.account_number,
                "mappings": [
                    {
                        "category": m.category_name,
                        "detail": m.detail_name,
                        "full": f"{m.category_name}:{m.detail_name}" if m.detail_name else m.category_name,
                        "priority": m.priority,
                        "confidence": m.confidence
                    }
                    for m in mappings
                ]
            })

        return result

    def get_categories_hierarchy(self) -> List[Dict]:
        """Get all categories with their hierarchy"""
        categories = self.db.query(Category).filter(
            Category.is_active == True,
            Category.parent_id == None
        ).all()

        result = []
        for category in categories:
            result.append({
                "id": category.id,
                "name": category.name,
                "description": category.description,
                "children": [
                    {
                        "id": child.id,
                        "name": child.name,
                        "description": child.description
                    }
                    for child in category.subcategories if child.is_active
                ]
            })

        return result
