#!/usr/bin/env python3
"""Quick test of merge recipient logic."""

from collections import defaultdict

from database.connection import SessionLocal
from database.models import Recipient

db = SessionLocal()

try:
    # Get all recipients
    all_recipients = db.query(Recipient).all()
    active_recipients = db.query(Recipient).filter(Recipient.is_active == True).all()

    print(f"Total recipients (all): {len(all_recipients)}")
    print(f"Total recipients (active only): {len(active_recipients)}")
    print(f"Inactive recipients: {len(all_recipients) - len(active_recipients)}")

    recipients = active_recipients  # Use active only for duplicate detection
    print(f"\nAnalyzing {len(recipients)} active recipients...")

    # Group by name
    by_name = defaultdict(list)
    for r in recipients:
        by_name[r.name].append(r)

    # Find duplicates
    dups = {n: rs for n, rs in by_name.items() if len(rs) > 1}
    print(f"Names with duplicates: {len(dups)}")

    if dups:
        print("\nFirst 10 duplicate groups:")
        for i, (name, recs) in enumerate(list(dups.items())[:10], 1):
            print(f"\n{i}. {name} ({len(recs)} recipients)")

            # Group by account
            by_acct = defaultdict(list)
            for r in recs:
                key = r.account_number if r.account_number else 'NULL'
                by_acct[key].append(r)

            for acct, group in by_acct.items():
                if len(group) > 1:
                    print(f"   ✓ MERGEABLE: {len(group)} with account={acct[:30] if acct != 'NULL' else 'NULL'}")
                    print(f"      IDs: {[r.id for r in group]}")
                    print(f"      Categories: {[r.default_category_id for r in group]}")

finally:
    db.close()
