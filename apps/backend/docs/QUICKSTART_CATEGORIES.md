# Category Management System - Quick Start Guide

## What Has Been Implemented

### ✅ Hierarchical Category System

The system now supports hierarchical categories with "General:Detailed" format:

- **General categories**: Parent categories (e.g., "Food", "Transportation")
- **Detailed categories**: Child/subcategories (e.g., "Groceries", "Gas")
- **Full path storage**: Complete path like "Food:Groceries" for easy filtering

### ✅ Database Schema Updates

**Category Model Enhanced:**

- `category_type`: 'general' or 'detailed'
- `full_path`: Complete hierarchy path (e.g., "Food:Groceries")
- Indexed for fast queries
- Parent-child relationships maintained

### ✅ CategoryService Class

Location: `services/category_service.py`

**Key Methods:**

1. **`get_or_create_category(category_path)`** - Automatically creates General and Detailed categories
2. **`import_category_mappings_from_csv(file_path)`** - Import recipient-to-category mappings from CSV
3. **`apply_recipient_categories_to_transactions()`** - Apply default categories to transactions
4. **`get_uncategorized_recipients()`** - Find recipients without categories
5. **`get_uncategorized_transactions()`** - Find transactions without categories
6. **`get_category_statistics()`** - Get comprehensive statistics
7. **`export_category_mappings_to_csv()`** - Export mappings for backup/editing
8. **`bulk_assign_category()`** - Assign category to multiple recipients at once

### ✅ Documentation Created

1. **CATEGORY_MANAGEMENT.md** - Complete guide with examples
2. **category_mappings_template.csv** - Sample CSV template
3. **This QUICKSTART.md** - Quick reference

## Immediate Next Steps

### Step 1: Update Database Schema

Since we added new fields to the Category model, you need to update your database:

```bash
# Option A: Reset database (WARNING: Deletes all data)
python cli.py reset-db --force

# Option B: Manually add columns (recommended if you have data)
# Use SQL to alter the existing database:
```

SQL to run if you have existing data:

```sql
ALTER TABLE categories
    ADD COLUMN category_type VARCHAR(20);
ALTER TABLE categories
    ADD COLUMN full_path VARCHAR(200) UNIQUE;
CREATE INDEX idx_category_path ON categories (full_path);

-- Update existing categories
UPDATE categories
SET category_type = 'general',
    full_path     = name
WHERE parent_id IS NULL;
UPDATE categories
SET category_type = 'detailed'
WHERE parent_id IS NOT NULL;
```

### Step 2: Prepare Your Category Mappings

Create a CSV file with your recipient-to-category mappings:

**Example `my_categories.csv`:**

```csv
Recipient,Category
"Walmart","Food:Groceries"
"McDonald's","Food:Restaurants"
"Shell Gas","Transportation:Gas"
"Netflix","Entertainment:Streaming"
```

Use the provided template: `category_mappings_template.csv`

### Step 3: Import Using Python

Since there are CLI syntax issues to fix, use Python directly for now:

```python
from database.connection import SessionLocal
from services.category_service import CategoryService

db = SessionLocal()
cat_service = CategoryService(db)

# Import your mappings
result = cat_service.import_category_mappings_from_csv(
    file_path="my_categories.csv",
    recipient_column="Recipient",
    category_column="Category",
    has_header=True
)

print(f"Total processed: {result['total_processed']}")
print(f"Mappings created: {result['mappings_created']}")
print(f"Categories created: {result['categories_created']}")

if result['recipients_not_found']:
    print(f"\nRecipients not found:")
    for name in result['recipients_not_found']:
        print(f"  - {name}")

# Apply categories to transactions
apply_result = cat_service.apply_recipient_categories_to_transactions()
print(f"\nTransactions updated: {apply_result['updated']}")

# View statistics
stats = cat_service.get_category_statistics()
print(f"\nCategory Statistics:")
print(f"  Total categories: {stats['total_categories']}")
print(f"  General: {stats['general_categories']}")
print(f"  Detailed: {stats['detailed_categories']}")
print(f"  Categorized transactions: {stats['categorized_transactions']}")
print(f"  Uncategorized transactions: {stats['uncategorized_transactions']}")

db.close()
```

### Step 4: View Your Categories

```python
from database.connection import SessionLocal
from services.category_service import CategoryService

db = SessionLocal()
cat_service = CategoryService(db)

# Get hierarchical view
categories = cat_service.get_all_categories_hierarchical()

for general in categories:
    print(f"\n📁 {general['name']} - {general['transaction_count']} transactions")
    for detailed in general['children']:
        print(f"   └─ {detailed['name']} ({detailed['full_path']}) - {detailed['transaction_count']} transactions")

db.close()
```

### Step 5: Handle Uncategorized Items

```python
from database.connection import SessionLocal
from services.category_service import CategoryService

db = SessionLocal()
cat_service = CategoryService(db)

# Find uncategorized recipients
uncategorized = cat_service.get_uncategorized_recipients()

print(f"\nUncategorized Recipients: {len(uncategorized)}")
for recipient in uncategorized[:10]:  # Show first 10
    print(f"  - {recipient.name} ({len(recipient.transactions)} transactions)")

# Assign categories manually
for recipient in uncategorized:
    # Example: assign based on name
    if "grocery" in recipient.name.lower() or "supermarket" in recipient.name.lower():
        category = cat_service.get_or_create_category("Food:Groceries")
        recipient.default_category_id = category.id

db.commit()

# Re-apply to transactions
cat_service.apply_recipient_categories_to_transactions()

db.close()
```

### Step 6: Export for Analysis

```python
from database.connection import SessionLocal
from services.category_service import CategoryService

db = SessionLocal()
cat_service = CategoryService(db)

# Export current mappings
result = cat_service.export_category_mappings_to_csv(
    file_path="current_mappings.csv",
    include_uncategorized=True
)

print(f"Exported {result['count']} recipients to {result['file_path']}")

db.close()
```

## API Endpoints Available

The category system integrates with the existing API:

### Get Categories (Frontend)

```
GET /api/categories
```

Returns all active categories.

### Create Category

```
POST /api/categories
Body: {
  "name": "category name",
  "description": "optional description",
  "color": "#FF5733"
}
```

### Get Statistics

```
GET /api/statistics
```

Returns transaction statistics including category breakdown.

## Common Workflows

### Workflow 1: Initial Setup

1. Prepare CSV with mappings
2. Import mappings: `cat_service.import_category_mappings_from_csv()`
3. Apply to transactions: `cat_service.apply_recipient_categories_to_transactions()`
4. Check stats: `cat_service.get_category_statistics()`

### Workflow 2: Adding New Categories

1. Find uncategorized: `cat_service.get_uncategorized_recipients()`
2. Create category: `cat_service.get_or_create_category("General:Detailed")`
3. Assign to recipient: `recipient.default_category_id = category.id`
4. Apply to transactions: `cat_service.apply_recipient_categories_to_transactions(recipient_id=...)`

### Workflow 3: Batch Updates

1. Export current mappings: `cat_service.export_category_mappings_to_csv()`
2. Edit CSV file with new categories
3. Re-import: `cat_service.import_category_mappings_from_csv()`
4. Apply: `cat_service.apply_recipient_categories_to_transactions(overwrite_existing=True)`

### Workflow 4: Analysis

1. Get hierarchical view: `cat_service.get_all_categories_hierarchical()`
2. Filter transactions by category in exports
3. Use statistics for reporting

## Category Statistics

Get comprehensive statistics:

```python
stats = cat_service.get_category_statistics()
```

Returns:

- Total categories (general + detailed)
- Categorized vs uncategorized transactions
- Categorized vs uncategorized recipients
- Coverage percentages

## Best Practices

### Category Naming

✅ DO:

- `Food:Groceries`
- `Transportation:Public`
- `Healthcare:Pharmacy`

❌ DON'T:

- `Food` (too general, use `Food:General` if needed)
- `Misc:Stuff` (not descriptive)
- `Food:Food` (redundant)

### Maintenance

1. **Regular Reviews**: Check uncategorized items weekly
2. **Consistent Naming**: Use consistent category names
3. **Backup Mappings**: Export mappings regularly
4. **Statistics Monitoring**: Track categorization coverage

## Troubleshooting

### Recipients Not Found During Import

- Check exact name matches (case-sensitive)
- List recipients: `db.query(Recipient).all()`
- Export to verify names: `cat_service.export_category_mappings_to_csv()`

### Categories Not Applied

- Must run `apply_recipient_categories_to_transactions()` after assigning
- Use `overwrite_existing=True` to update already-categorized transactions

### Low Coverage

- Export with uncategorized: `export_category_mappings_to_csv(include_uncategorized=True)`
- Review and add categories
- Re-import updated CSV

## Example: Complete Setup Script

```python
#!/usr/bin/env python3
"""
Complete category setup script
"""
from database.connection import SessionLocal
from services.category_service import CategoryService


def setup_categories():
    db = SessionLocal()
    cat_service = CategoryService(db)

    print("=" * 60)
    print("CATEGORY SETUP SCRIPT")
    print("=" * 60)

    # Step 1: Import mappings
    print("\n1. Importing category mappings...")
    result = cat_service.import_category_mappings_from_csv(
        file_path="my_categories.csv",
        recipient_column="Recipient",
        category_column="Category"
    )
    print(f"   ✓ Processed: {result['total_processed']}")
    print(f"   ✓ Mappings created: {result['mappings_created']}")
    print(f"   ✓ Categories created: {result['categories_created']}")

    # Step 2: Apply to transactions
    print("\n2. Applying categories to transactions...")
    apply_result = cat_service.apply_recipient_categories_to_transactions()
    print(f"   ✓ Transactions updated: {apply_result['updated']}")

    # Step 3: Show statistics
    print("\n3. Category Statistics:")
    stats = cat_service.get_category_statistics()
    print(f"   Categories: {stats['total_categories']} total")
    print(f"     - General: {stats['general_categories']}")
    print(f"     - Detailed: {stats['detailed_categories']}")
    print(f"   Transactions: {stats['categorized_transactions']} categorized")
    print(f"     - Uncategorized: {stats['uncategorized_transactions']}")

    total_txn = stats['categorized_transactions'] + stats['uncategorized_transactions']
    if total_txn > 0:
        coverage = (stats['categorized_transactions'] / total_txn) * 100
        print(f"     - Coverage: {coverage:.1f}%")

    # Step 4: Show hierarchy
    print("\n4. Category Hierarchy:")
    categories = cat_service.get_all_categories_hierarchical()
    for general in categories:
        print(f"\n   📁 {general['name']} ({general['transaction_count']} txns)")
        for detailed in general['children']:
            print(f"      └─ {detailed['name']} ({detailed['transaction_count']} txns)")

    # Step 5: Export for review
    print("\n5. Exporting mappings for review...")
    export_result = cat_service.export_category_mappings_to_csv(
        file_path="mappings_backup.csv",
        include_uncategorized=True
    )
    print(f"   ✓ Exported to: {export_result['file_path']}")

    print("\n" + "=" * 60)
    print("SETUP COMPLETE!")
    print("=" * 60)

    db.close()


if __name__ == "__main__":
    setup_categories()
```

Save this as `setup_categories.py` and run it after preparing your CSV file!

## Summary

You now have a complete hierarchical category management system that:

- ✅ Supports General:Detailed format
- ✅ Automatically creates categories from paths
- ✅ Imports mappings from CSV
- ✅ Applies categories to transactions
- ✅ Tracks uncategorized items
- ✅ Provides comprehensive statistics
- ✅ Exports for backup/editing
- ✅ Integrates with existing API

All functionality is working and ready to use via Python scripts!

