"""
Transaction Repository

Centralizes all SQLAlchemy operations for transactions.
"""
from datetime import date, datetime
from typing import Optional, List

from sqlalchemy.orm import Session

from database.models import Transaction, Recipient, Category


class TransactionRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_transactions(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime | date] = None,
            end_date: Optional[datetime | date] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            limit: int = 100,
            offset: int = 0
    ) -> List[Transaction]:
        query = self.db.query(Transaction)

        if bank_account:
            query = query.filter(Transaction.bank_account.ilike(f"%{bank_account}%"))
        if start_date:
            query = query.filter(Transaction.date >= start_date)
        if end_date:
            query = query.filter(Transaction.date <= end_date)
        if category_id:
            query = query.filter(Transaction.category_id == category_id)
        if recipient_id:
            query = query.filter(Transaction.recipient_id == recipient_id)
        if recipient_name:
            query = query.join(Recipient).filter(Recipient.name.ilike(f"%{recipient_name}%"))

        return query.order_by(Transaction.date.desc()).offset(offset).limit(limit).all()

    def create(self, txn: Transaction) -> Transaction:
        self.db.add(txn)
        self.db.commit()
        self.db.refresh(txn)
        return txn

    def update(self, txn: Transaction) -> Transaction:
        self.db.commit()
        self.db.refresh(txn)
        return txn

    def delete(self, txn: Transaction) -> None:
        self.db.delete(txn)
        self.db.commit()

    def get_by_id(self, transaction_id: int) -> Optional[Transaction]:
        return self.db.query(Transaction).filter(Transaction.id == transaction_id).first()

    def delete_by_recipient_id(self, recipient_id: int) -> int:
        deleted = self.db.query(Transaction).filter(Transaction.recipient_id == recipient_id).delete()
        self.db.commit()
        return deleted

    def get_categories_by_ids(self, ids: List[int]) -> List[Category]:
        return self.db.query(Category).filter(Category.id.in_(ids)).all()

    def get_uncategorized(self, limit: int = 100) -> List[Transaction]:
        return self.db.query(Transaction).filter(
            Transaction.category_id.is_(None)
        ).order_by(Transaction.date.desc()).limit(limit).all()

    def count_categorized_vs_uncategorized(self) -> dict:
        from sqlalchemy import func
        from database.models import Recipient
        categorized = self.db.query(func.count(Transaction.id)).join(
            Recipient
        ).filter(
            (Transaction.category_id.isnot(None)) |
            (Recipient.default_category_id.isnot(None))
        ).scalar() or 0
        uncategorized = self.db.query(func.count(Transaction.id)).join(
            Recipient
        ).filter(
            Transaction.category_id.is_(None),
            Recipient.default_category_id.is_(None)
        ).scalar() or 0
        return {'categorized': int(categorized), 'uncategorized': int(uncategorized)}

    def get_by_bank_reference(self, bank_reference: str) -> Optional[Transaction]:
        return self.db.query(Transaction).filter(Transaction.bank_reference == bank_reference).first()
