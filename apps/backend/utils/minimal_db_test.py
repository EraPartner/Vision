#!/usr/bin/env python3
"""Minimal test to check database connection and recipient count."""

from database.connection import SessionLocal, DATABASE_URL
from database.models import Recipient

print("=" * 80)
print(f"Database: {DATABASE_URL}")
print("=" * 80)

db = SessionLocal()

try:
    # Count all recipients
    total_count = db.query(Recipient).count()
    print(f"Total recipients in database: {total_count}")

    # Count active recipients
    active_count = db.query(Recipient).filter(Recipient.is_active == True).count()
    print(f"Active recipients: {active_count}")

    # Get first 5 recipients
    first_5 = db.query(Recipient).limit(5).all()
    print(f"\nFirst 5 recipients:")
    for r in first_5:
        print(f"  ID {r.id}: {r.name}, active={r.is_active}")

    # Query with the same pattern as merge_recipients
    from sqlalchemy import func
    from database.models import Transaction

    query_result = db.query(
        Recipient.id,
        Recipient.name,
        func.count(Transaction.id.distinct()).label('transaction_count')
    ).filter(
        Recipient.is_active == True
    ).outerjoin(
        Transaction, Recipient.id == Transaction.recipient_id
    ).group_by(
        Recipient.id
    ).all()

    print(f"\nQuery with group_by returned: {len(query_result)} results")

    if len(query_result) > 0:
        print(
            f"First result: ID={query_result[0].id}, name={query_result[0].name}, count={query_result[0].transaction_count}")

finally:
    db.close()
