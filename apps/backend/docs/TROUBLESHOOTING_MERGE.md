# Recipient Merge - Troubleshooting Guide

## Problem: "Only 1 recipient is queried from the database"

If the merge script is only finding 1 recipient when you know there are more, follow these steps:

### Step 1: Verify Database Connection

Run the minimal test:

```bash
python minimal_db_test.py
```

This will show:

- Total recipients in database
- Active recipients count
- First 5 recipients
- Results from the grouped query

**Expected output:**

```
Total recipients in database: 650+
Active recipients: 650+
First 5 recipients:
  ID 1: RECIPIENT NAME, active=True
  ...
Query with group_by returned: 650+ results
```

**If you see only 1 recipient:** There's a database connection or configuration issue.

### Step 2: Check Database File

Verify you're connecting to the correct database:

```bash
sqlite3 financial_transactions.db "SELECT COUNT(*) FROM recipients;"
sqlite3 financial_transactions.db "SELECT COUNT(*) FROM recipients WHERE is_active = 1;"
```

### Step 3: Run Quick Test

```bash
python quick_test_merge.py
```

This shows duplicate detection without the merge complexity.

### Step 4: Check for Configuration Issues

Possible causes:

1. **Wrong database file**: Check `DATABASE_URL` in your environment
2. **SQLAlchemy query limit**: Check if there's a default limit configured
3. **is_active filter**: Most recipients might be marked inactive

### Step 5: Run Merge Script with Debug Output

```bash
python -m utils.merge_recipients --dry-run
```

Look for the DEBUG lines:

```
DEBUG: About to execute query...
DEBUG: Queried X recipients from database
DEBUG: Found Y unique recipient names
DEBUG: Z names have multiple recipients
```

## Common Issues

### Issue: UniqueConstraint on account_number

The database has a unique constraint on `account_number`, but this allows multiple NULL values. Duplicates occur when:

- Multiple recipients have the same name and NULL account_number
- Multiple recipients have the same name and the same account_number (this should be rare due to the constraint)

### Issue: All recipients are inactive

If most recipients show `is_active=False`, they may have been previously merged. To see them:

```bash
sqlite3 financial_transactions.db "SELECT is_active, COUNT(*) FROM recipients GROUP BY is_active;"
```

### Issue: SQLAlchemy grouping returns one row per group

The `.group_by(Recipient.id)` clause groups by unique ID, so each recipient appears once. This is correct behavior - the
issue is if the query returns too few results overall.

## Files for Debugging

1. **minimal_db_test.py** - Simplest test, no logging, just print statements
2. **quick_test_merge.py** - Shows duplicate groups without merge logic
3. **test_duplicates_simple.py** - Detailed duplicate analysis
4. **utils/merge_recipients.py** - Full merge script with dry-run

## Expected Behavior

Based on your database, you should see:

- ~650-700 total recipients
- ~100+ names with duplicate recipients
- ~45-50 mergeable groups (same name + same/null account number)

If you're seeing significantly different numbers, there's a configuration or database issue.

