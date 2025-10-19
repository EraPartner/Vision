# Guide: Import Category Mappings from Activity CSV

## Overview

This guide explains how to import recipient-category mappings from CSV files that contain transaction history with
category assignments. The system uses a **most-occurring strategy** to handle duplicate mappings.

## Problem Solved

When you have a CSV file with columns like `Date, Check, Recipient, Category, Amount`, you'll often find:

- **Duplicate mappings**: The same recipient appears multiple times with different categories
- **Manual overrides**: Some transactions were manually categorized differently than the default

The `import-categories-from-activity` command solves this by:

1. Tallying all occurrences of each recipient-category pair
2. Selecting the **most frequently occurring category** for each recipient
3. Storing that as the default category in the database
4. Properly parsing hierarchical categories in `General:Detail` format

## Command Usage

### Basic Usage

```bash
python cli.py import-categories-from-activity your_activity.csv
```

This will:

- Read the CSV file
- Parse categories in `General:Detail` format
- Create both general and detailed category entries
- Store the most common category for each recipient
- Create missing recipients automatically

### Advanced Options

```bash
python cli.py import-categories-from-activity your_activity.csv \
  --recipient-columns "Recipient,Payee,Description" \
  --category-columns "Category" \
  --delimiters ",;	" \
  --create-recipients \
  --apply-to-transactions
```

### Command Options

| Option                    | Description                                           | Default                       |
|---------------------------|-------------------------------------------------------|-------------------------------|
| `file`                    | Path to CSV file (supports wildcards like `*.csv`)    | Required                      |
| `--recipient-columns`     | Comma-separated column names to try for recipient     | `Recipient,Payee,Description` |
| `--category-columns`      | Comma-separated column names to try for category      | `Category`                    |
| `--delimiters`            | Comma-separated delimiters to try                     | `,;	` (comma, semicolon, tab) |
| `--create-recipients`     | Create recipients if they don't exist                 | `True` (default)              |
| `--no-create-recipients`  | Don't create missing recipients                       | -                             |
| `--apply-to-transactions` | Apply categories to existing transactions immediately | `False` (default)             |

## How It Works

### 1. Tallying Phase

The system reads all rows and counts occurrences:

```
Recipient: "Walmart"
  - Shopping:Groceries: 25 times
  - Shopping:General: 3 times
  - Food:Dining: 1 time (manual override)
  
Result: Stores "Shopping:Groceries" as default category
```

### 2. Category Parsing

Categories in `General:Detail` format are properly parsed:

- `Food:Groceries` → Creates "Food" (general) and "Groceries" (detailed)
- `Shopping:General` → Creates "Shopping" (general) and "General" (detailed)
- `Income` → Creates only "Income" (general category)

### 3. Tie Breaking

If two categories have the same count, the system uses:

1. Highest count (most occurrences)
2. Lexicographic order of full_path (alphabetical)

Example:

```
Recipient: "Amazon"
  - Shopping:Online: 10 times
  - Shopping:General: 10 times
  
Result: Stores "Shopping:General" (comes first alphabetically)
```

## Example Workflow

### Step 1: Prepare Your CSV

Your CSV should have these columns:

```csv
Date,Check,Recipient,Category,Amount
2024-01-15,,Walmart,Shopping:Groceries,-125.50
2024-01-20,,Walmart,Shopping:Groceries,-89.30
2024-01-25,,Walmart,Shopping:General,-45.00
2024-02-01,,Target,Shopping:Groceries,-67.80
```

### Step 2: Import Categories

```bash
python cli.py import-categories-from-activity transactions.csv
```

Output:

```
Importing category mappings from activity CSV file(s)...
Using most-occurring category strategy for duplicate mappings

Processing 1 file(s)...

✓ Import completed!
  Files processed: 1
  Rows read: 4
  Recipients considered: 2
  Recipients updated: 2
  Recipients created: 0
  Categories created: 2

💡 Run 'python cli.py category-stats' to see overall categorization coverage
   Run 'python cli.py apply-categories' to apply these categories to existing transactions
```

### Step 3: Verify Results

```bash
python cli.py recipients
```

Should show:

```
ID    Name                                     Account Number       Category             Transactions
---   ---------------------------------------- -------------------- -------------------- ------------
1     Walmart                                  N/A                  Groceries            3           
2     Target                                   N/A                  Groceries            1           
```

### Step 4: Apply to Transactions

```bash
python cli.py apply-categories
```

This applies the default categories to all uncategorized transactions.

### Step 5: Check Coverage

```bash
python cli.py category-stats
```

Output:

```
📊 Category Statistics
============================================================

Categories:
  Total: 3
  General (parent): 1
  Detailed (child): 2

Transactions:
  Categorized: 4
  Uncategorized: 0
  Coverage: 100.0%

Recipients:
  Categorized: 2
  Uncategorized: 0
  Coverage: 100.0%
```

## Processing Multiple Files

You can use wildcards to process multiple CSV files at once:

```bash
python cli.py import-categories-from-activity "transactions_*.csv"
```

Or specify multiple files explicitly by calling the command multiple times, or by modifying the file to accept multiple
file arguments.

## Handling Edge Cases

### Recipients Not in Database

If `--create-recipients` is enabled (default), new recipients will be created automatically. Otherwise, they'll be
listed in the "Recipients not found" section of the output.

### Different Delimiters

The system automatically tries common delimiters (comma, semicolon, tab):

```bash
python cli.py import-categories-from-activity data.csv
```

If you need custom delimiters:

```bash
python cli.py import-categories-from-activity data.csv --delimiters "|,;"
```

### Different Column Names

If your CSV uses different column names:

```bash
python cli.py import-categories-from-activity data.csv \
  --recipient-columns "Payee,Merchant,Description" \
  --category-columns "Category,Type,Class"
```

## Manual Overrides

After importing, you can still manually override specific recipients:

```bash
python cli.py assign-category "Food:Dining" --recipient-id 5
```

Or update individual transactions through the API.

## Related Commands

- `python cli.py categories --hierarchical` - View all categories in hierarchical format
- `python cli.py recipients` - View all recipients with their assigned categories
- `python cli.py show-uncategorized` - Show uncategorized recipients and transactions
- `python cli.py apply-categories` - Apply recipient categories to transactions
- `python cli.py category-stats` - Show categorization statistics

## Notes

1. **Most-occurring wins**: The category that appears most frequently for a recipient becomes the default
2. **Manual overrides preserved**: Less frequent categories in your CSV represent manual overrides, which you can handle
   individually after import
3. **Hierarchical categories**: The system properly handles `General:Detail` format and creates parent-child
   relationships
4. **Case-insensitive matching**: Recipients are matched case-insensitively (e.g., "walmart" matches "Walmart")
5. **Display name**: The most commonly used casing for recipient names is preserved

## Troubleshooting

### No files found

```bash
✗ No files found matching: transactions.csv
```

**Solution**: Check the file path. Use quotes if the path contains spaces or wildcards.

### Missing columns

```bash
⚠️  Skipped files (1):
    - transactions.csv: Missing Recipient or Category header
```

**Solution**: Verify your CSV has the required columns. Use `--recipient-columns` and `--category-columns` to specify
custom names.

### Recipients not found

```bash
⚠️  Recipients not found (3):
    - John Doe
    - Acme Corp
    - ...
```

**Solution**: Either ensure recipients exist in the database first, or use `--create-recipients` (enabled by default) to
create them automatically.

