# Category Management Guide

## Overview

This system implements hierarchical categories with a "General:Detailed" format, allowing you to organize transactions
into main categories and subcategories. For example:

- `Food:Groceries`
- `Food:Restaurants`
- `Transportation:Gas`
- `Entertainment:Movies`

## Database Structure

Categories are stored with:

- **General categories**: Parent categories (e.g., "Food", "Transportation")
- **Detailed categories**: Child categories (e.g., "Groceries", "Restaurants")
- **Full path**: Complete hierarchy path (e.g., "Food:Groceries")

## Quick Start Workflow

### 1. Prepare Your Category Mappings CSV

Create a CSV file with recipient-to-category mappings:

```csv
Recipient,Category
"Walmart","Food:Groceries"
"McDonald's","Food:Restaurants"
"Shell Gas Station","Transportation:Gas"
"Netflix","Entertainment:Streaming"
"Amazon","Shopping:Online"
```

### 2. Import Category Mappings

```bash
python cli.py import-category-mappings mappings.csv --recipient-column Recipient --category-column Category
```

This will:

- Create all categories automatically (both General and Detailed)
- Assign default categories to matching recipients
- Report any recipients not found in your database

### 3. Apply Categories to Transactions

After importing mappings, apply them to your transactions:

```bash
# Apply to all uncategorized transactions
python cli.py apply-categories

# Apply to specific recipient
python cli.py apply-categories --recipient-id 5

# Overwrite existing categories
python cli.py apply-categories --overwrite
```

### 4. Check Your Progress

View statistics:

```bash
python cli.py category-stats
```

Output example:

```
📊 Category Statistics
==========================================================

Categories:
  Total: 15
  General (parent): 5
  Detailed (child): 10

Transactions:
  Categorized: 1,234
  Uncategorized: 45
  Coverage: 96.5%

Recipients:
  Categorized: 89
  Uncategorized: 11
  Coverage: 89.0%
```

## Detailed Commands

### Import Category Mappings

```bash
python cli.py import-category-mappings <file> [options]
```

**Options:**

- `--recipient-column <name>`: Column name for recipients (default: "Recipient")
- `--category-column <name>`: Column name for categories (default: "Category")
- `--no-header`: Use if CSV has no header row

**CSV Format:**

```csv
Recipient,Category
"Store Name","General:Detailed"
```

### Apply Categories to Transactions

```bash
python cli.py apply-categories [options]
```

**Options:**

- `--recipient-id <id>`: Apply only for specific recipient
- `--overwrite`: Overwrite existing categories (default: only update uncategorized)

### Show Uncategorized Items

```bash
python cli.py show-uncategorized [options]
```

**Options:**

- `--type <type>`: Show "recipients", "transactions", or "all" (default: all)
- `--limit <n>`: Limit results shown (default: 50)

**Example:**

```bash
# Show uncategorized recipients
python cli.py show-uncategorized --type recipients --limit 20

# Show uncategorized transactions
python cli.py show-uncategorized --type transactions
```

### Assign Category Manually

Assign a category to one or more recipients:

```bash
# Single recipient
python cli.py assign-category "Food:Groceries" --recipient-id 5

# Multiple recipients
python cli.py assign-category "Food:Restaurants" --recipient-ids "5,12,23,45"
```

The category will be created automatically if it doesn't exist.

### List Categories

```bash
# Flat view
python cli.py categories

# Hierarchical view (tree structure)
python cli.py categories --hierarchical
```

**Hierarchical view example:**

```
📁 Food (ID: 1)
   Path: Food
   Transactions: 450
   └─ Groceries (ID: 2)
      Path: Food:Groceries
      Transactions: 320
   └─ Restaurants (ID: 3)
      Path: Food:Restaurants
      Transactions: 130
```

### Export Category Mappings

Export current mappings to CSV for backup or editing:

```bash
# Export only categorized recipients
python cli.py export-category-mappings mappings_backup.csv

# Include uncategorized recipients
python cli.py export-category-mappings all_mappings.csv --include-uncategorized
```

## Working with Uncategorized Items

### Step-by-Step Process

1. **Check what needs categorization:**
   ```bash
   python cli.py show-uncategorized --type recipients
   ```

2. **Export uncategorized recipients:**
   ```bash
   python cli.py export-category-mappings uncategorized.csv --include-uncategorized
   ```

3. **Edit the CSV file** in Excel or your preferred editor, adding categories

4. **Re-import the updated mappings:**
   ```bash
   python cli.py import-category-mappings uncategorized.csv
   ```

5. **Apply the new categories:**
   ```bash
   python cli.py apply-categories
   ```

6. **Verify:**
   ```bash
   python cli.py category-stats
   ```

## Adding New Categories for Future Transactions

When you encounter a new recipient that doesn't have a category:

### Option 1: Quick Assignment (CLI)

```bash
# Find the recipient ID
python cli.py recipients | grep "New Store"

# Assign category
python cli.py assign-category "Food:Groceries" --recipient-id 123
```

### Option 2: Batch Assignment (CSV)

1. Export current mappings:
   ```bash
   python cli.py export-category-mappings current_mappings.csv --include-uncategorized
   ```

2. Edit the CSV to add new categories

3. Re-import:
   ```bash
   python cli.py import-category-mappings current_mappings.csv
   ```

### Option 3: Programmatically (Python)

```python
from database.connection import SessionLocal
from services.category_service import CategoryService

db = SessionLocal()
cat_service = CategoryService(db)

# Create or get category
category = cat_service.get_or_create_category("Food:Groceries")

# Assign to recipient
from database.models import Recipient

recipient = db.query(Recipient).filter(Recipient.name == "New Store").first()
recipient.default_category_id = category.id
db.commit()

# Apply to transactions
cat_service.apply_recipient_categories_to_transactions(recipient_id=recipient.id)

db.close()
```

## Category Naming Best Practices

### Good Category Names

✅ `Food:Groceries` - Clear and specific
✅ `Transportation:Public` - Descriptive
✅ `Healthcare:Pharmacy` - Well organized
✅ `Entertainment:Streaming` - Subcategory is clear

### Avoid

❌ `Food` - Too general (use `Food:General` if needed)
❌ `Misc:Stuff` - Not descriptive
❌ `Food:Food` - Redundant

### Recommended Category Structure

```
Income:
  - Salary
  - Freelance
  - Investment

Food:
  - Groceries
  - Restaurants
  - Coffee

Transportation:
  - Gas
  - Public
  - Parking
  - Maintenance

Housing:
  - Rent
  - Utilities
  - Maintenance
  - Insurance

Entertainment:
  - Streaming
  - Movies
  - Games
  - Events

Shopping:
  - Clothing
  - Electronics
  - Home
  - Online

Healthcare:
  - Pharmacy
  - Doctor
  - Insurance

Bills:
  - Phone
  - Internet
  - Subscriptions
```

## Statistics and Reporting

### Get Detailed Statistics

```bash
python cli.py category-stats
```

### Filter Transactions by Category

```bash
# List all transactions in a category
python cli.py list --category-id 5

# Export transactions by category
python cli.py export output.csv "Bank Name" --category-id 5 --from-date 2024-01-01
```

### View Hierarchical Category Tree

```bash
python cli.py categories --hierarchical
```

This shows:

- All general categories
- Their detailed subcategories
- Transaction count for each
- Full path for easy reference

## Troubleshooting

### Recipients Not Found During Import

If you see "Recipients not found" warnings:

1. Check recipient names match exactly (case-sensitive)
2. List all recipients: `python cli.py recipients`
3. Export mappings to see current names: `python cli.py export-category-mappings check.csv --include-uncategorized`

### Categories Not Applied to Transactions

After importing mappings, you must run:

```bash
python cli.py apply-categories
```

This step actually updates the transactions with the category assignments.

### Checking Coverage

Use `category-stats` to see your categorization progress:

```bash
python cli.py category-stats
```

Look for:

- Transaction coverage percentage
- Number of uncategorized recipients
- Number of uncategorized transactions

## Integration with Transaction Import

Categories are automatically applied when transactions are imported if the recipient already has a default category
assigned. This means:

1. Import your transactions as usual
2. Transactions from categorized recipients automatically get categories
3. New recipients appear as uncategorized
4. Assign categories to new recipients
5. Run `apply-categories` to update their transactions

## API Usage

The category system also has API endpoints (see main.py):

- `GET /api/categories` - List all categories
- `POST /api/categories` - Create a new category
- `GET /api/statistics` - Get category statistics including breakdown

These can be used by a frontend application for category management.

## Example Complete Workflow

```bash
# 1. Reset database (if starting fresh)
python cli.py reset-db --force

# 2. Initialize database
python cli.py init-db

# 3. Import transactions
python cli.py import transactions.csv Revolut

# 4. Check what we have
python cli.py recipients
python cli.py category-stats

# 5. Create category mappings CSV file
# (Edit mappings.csv with your categories)

# 6. Import category mappings
python cli.py import-category-mappings mappings.csv

# 7. Apply categories to transactions
python cli.py apply-categories

# 8. Check results
python cli.py category-stats
python cli.py categories --hierarchical

# 9. View categorized transactions
python cli.py list --limit 100

# 10. Export for analysis
python cli.py export categorized_transactions.csv "Revolut" --from-date 2024-01-01
```

## Next Steps

1. **Prepare your category mapping file** with recipient-to-category assignments
2. **Import the mappings** using `import-category-mappings`
3. **Apply categories** to existing transactions
4. **Monitor progress** with `category-stats`
5. **Maintain categories** as new recipients appear

Your transactions will now be properly categorized for analysis and reporting!

