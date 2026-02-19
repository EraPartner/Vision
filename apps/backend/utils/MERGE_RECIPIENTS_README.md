# Recipient Merge Utility

## Purpose

This script identifies and merges duplicate recipients in the financial transactions database. Recipients are considered
duplicates if they share the same name AND the same account number (or both have NULL account numbers).

## Usage

### Preview Changes (Dry Run)

To preview what will be merged without making any changes:

```bash
python -m utils.merge_recipients --dry-run
```

### Preview for Specific Recipient

To check duplicates for a specific recipient name:

```bash
python -m utils.merge_recipients --dry-run --name "IBE BRICHAU"
```

### Execute Merge

To actually perform the merge (you will be prompted for confirmation):

```bash
python -m utils.merge_recipients
```

### Execute Merge for Specific Recipient

```bash
python -m utils.merge_recipients --name "IBE BRICHAU"
```

## Merging Rules

1. **Name Matching**: Recipients with the same name are candidates for merging
2. **Account Number Matching**:
    - If both recipients have account numbers, they must match exactly to be merged
    - If both have NULL account numbers, they can be merged based on name alone
    - Recipients with different account numbers will NOT be merged (they represent different entities)

## Category Conflicts

The script identifies and warns about cases where duplicate recipients have different `default_category_id` values.
These conflicts are highlighted with a ⚠️ symbol in the output.

When merging, the script will:

- Keep the category from the recipient with the most transactions
- If transaction counts are equal, keep the category from the recipient with the most complete information
- If still equal, keep the category from the oldest recipient

## Data Preservation

When merging recipients, the script preserves maximum information:

- **Address**: Kept from primary recipient, or first non-NULL from others
- **Account Number**: Kept from primary recipient, or first non-NULL from others
- **Notes**: Combined from all recipients (separated by " | ")
- **Category**: Kept from primary recipient, or first non-NULL from others

## Transaction Updates

All transactions and planned transactions linked to merged recipients are automatically reassigned to the primary
recipient.

## Quick Test

To quickly verify duplicates exist in your database:

```bash
python quick_test_merge.py
```

This will show the first 10 duplicate groups without requiring any confirmation.

## Example Output

```
================================================================================
MERGE SUMMARY
================================================================================

Total duplicate groups: 45
Groups with category conflicts: 3

--- Top 20 Duplicate Groups by Transaction Count ---

 1. IBE BRICHAU
    Duplicates: 2 recipients
       ID 223: acct=LT81 3250 0106 0089 3968, txns= 621, cat=9
       ID 242: acct=BE89 6509 6582 5185, txns= 967, cat=9
    Total Transactions: 1588
    Total Planned: 0
    Category IDs: [9]

 2. ⚠️  AMAZON
    Duplicates: 2 recipients
       ID 123: acct=NULL, txns= 45, cat=7
       ID 293: acct=NULL, txns= 32, cat=42
    Total Transactions: 77
    Total Planned: 2
    Category IDs: [7, 42]
```

## Safety Features

- **Dry-run mode** by default shows what will happen without making changes
- **Confirmation prompt** before executing actual merge
- **Soft deletion** - merged recipients are marked inactive, not permanently deleted
- **Transaction rollback** on any error during merge
- **Comprehensive logging** of all actions taken

## Troubleshooting

If the script shows "No duplicates found" but you know duplicates exist:

1. Check that recipient names are normalized (should be uppercase)
2. Verify the database connection is correct
3. Run `python quick_test_merge.py` to see raw duplicate data
4. Check the account numbers - recipients with different account numbers won't merge

