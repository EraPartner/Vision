# How to Delete Transactions by Recipient

This guide explains three methods to remove all transactions from a specific recipient (e.g., "recipientA").

---

## Method 1: Using the CLI (Recommended) ⭐

I've added a new `delete-transactions` command to your CLI tool.

### Basic Usage

Delete transactions by recipient name:

```bash
python cli.py delete-transactions --recipient-name "recipientA"
```

Delete transactions by recipient ID:

```bash
python cli.py delete-transactions --recipient-id 5
```

### Advanced Options

Skip confirmation prompt (use with caution):

```bash
python cli.py delete-transactions --recipient-name "recipientA" --force
```

Delete transactions AND remove the recipient entirely:

```bash
python cli.py delete-transactions --recipient-name "recipientA" --delete-recipient
```

### Step-by-Step Example

1. **First, find the recipient** to confirm the name:
   ```bash
   python cli.py recipients
   ```

   This will show all recipients with their IDs and transaction counts.

2. **Delete the transactions**:
   ```bash
   python cli.py delete-transactions --recipient-name "recipientA"
   ```

   You'll see a confirmation prompt like:
   ```
   ⚠️  WARNING: This will DELETE 15 transaction(s) from recipient 'recipientA'
      Are you sure you want to continue? (yes/no):
   ```

3. **Confirm by typing `yes`**

4. **Verify deletion**:
   ```bash
   python cli.py list --recipient-name "recipientA"
   ```

   Should return no results.

---

## Method 2: Using Python Directly

Create a Python script or run interactively:

```python
from database.connection import SessionLocal
from database.models import Transaction, Recipient

# Open database session
db = SessionLocal()

# Find the recipient by name
recipient = db.query(Recipient).filter(Recipient.name == "recipientA").first()

if recipient:
    # Count transactions before deletion
    count = db.query(Transaction).filter(Transaction.recipient_id == recipient.id).count()
    print(f"Found {count} transactions for '{recipient.name}'")

    # Delete all transactions for this recipient
    deleted_count = db.query(Transaction).filter(Transaction.recipient_id == recipient.id).delete()
    db.commit()

    print(f"✓ Deleted {deleted_count} transactions")

    # Optional: Delete the recipient too
    # db.delete(recipient)
    # db.commit()
else:
    print("Recipient 'recipientA' not found")

db.close()
```

### Save as a Script

Save the above as `delete_recipient_transactions.py` and run:

```bash
python delete_recipient_transactions.py
```

---

## Method 3: Direct SQL Query

If you need to use SQL directly on the database:

```bash
sqlite3 financial_transactions.db
```

Then run:

```sql
-- Find the recipient ID first
SELECT id, name
FROM recipients
WHERE name = 'recipientA';

-- Delete transactions (replace 123 with the actual recipient_id)
DELETE
FROM transactions
WHERE recipient_id = 123;

-- Verify deletion
SELECT COUNT(*)
FROM transactions
WHERE recipient_id = 123;

-- Exit sqlite
.quit
```

---

## Finding Recipients

### List all recipients:

```bash
python cli.py recipients
```

Output shows:

```
ID    Name                     Account Number    Category    Transactions
---   ----------------------   ---------------   ----------  ------------
1     recipientA               N/A               None        15
2     recipientB               N/A               Food        8
```

### List transactions by recipient:

```bash
python cli.py list --recipient-name "recipientA"
```

### Search for partial matches:

```bash
python cli.py list --recipient-name "recipient"
```

This will show all transactions where the recipient name contains "recipient".

---

## Safety Tips

1. **Always backup your database first**:
   ```bash
   cp financial_transactions.db financial_transactions.db.backup
   ```

2. **Use `--recipient-name` carefully** - it must match exactly (case-sensitive)

3. **Check the count before deletion** using `list` command

4. **Don't use `--force` unless you're absolutely sure**

5. **Test on a copy first** if you're unsure

---

## Troubleshooting

### "Recipient not found"

- Check the exact spelling and case: `python cli.py recipients | grep -i recipient`
- Use the recipient ID instead: `--recipient-id 5`

### "No transactions found"

- The recipient exists but has no transactions - nothing to delete

### Database locked error

- Close any other programs accessing the database
- Stop the API server if it's running: `pkill -f "python main.py"`

---

## Example Workflow

Here's a complete example of safely deleting transactions:

```bash
# 1. Backup database
cp financial_transactions.db financial_transactions.db.backup

# 2. Find the recipient
python cli.py recipients | grep -i recipientA

# 3. Check how many transactions they have
python cli.py list --recipient-name "recipientA" --limit 1000

# 4. Delete with confirmation
python cli.py delete-transactions --recipient-name "recipientA"

# 5. Verify deletion
python cli.py list --recipient-name "recipientA"
# Should return: "No transactions found"

# 6. Check recipient still exists (if needed)
python cli.py recipients | grep -i recipientA
```

---

## Need More Help?

- To delete transactions by date range, bank account, or category, use the API or Python method
- To bulk delete multiple recipients, create a Python script that loops through recipient names
- To permanently remove a recipient after deleting transactions, add `--delete-recipient` flag

