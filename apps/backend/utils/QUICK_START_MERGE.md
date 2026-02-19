# Recipient Merge Script - Quick Start Guide

## Strategy: Merge Non-Conflicting Recipients First

The script now **automatically skips** recipients with category conflicts by default, allowing you to:

1. First merge all the "safe" duplicates (same name, same/NULL account, same category)
2. Review category conflicts manually
3. Fix categories in the database
4. Run the script again to merge the remaining duplicates

## Usage

### 1. Preview Non-Conflicting Merges (RECOMMENDED FIRST STEP)

```bash
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend
python -m utils.merge_recipients --dry-run
```

This will show:

- ✅ Which recipients will be merged (no conflicts)
- ⚠️ Which recipients will be skipped (category conflicts)
- Detailed summary of all duplicates

### 2. Execute Non-Conflicting Merges

```bash
python -m utils.merge_recipients
```

This will:

- Merge all recipients **without** category conflicts
- Skip recipients with conflicts
- Show a summary of what was skipped

### 3. Review Category Conflicts

After running, the script will display skipped groups like:

```
⚠️  SKIPPED GROUPS (CATEGORY CONFLICTS)
================================================================================

5 groups were skipped due to category conflicts.
These require manual review to determine the correct category.
```

Check the earlier summary output to see which recipients have conflicts:

```
⚠️  CATEGORY CONFLICTS DETECTED
================================================================================

1. AMAZON
   ID 123: acct=NULL, category_id=  7, transactions=  45, created=2024-01-15
   ID 293: acct=NULL, category_id= 42, transactions=  32, created=2024-03-20
```

### 4. Fix Category Conflicts Manually

Use SQL or the API to update the categories:

```bash
sqlite3 financial_transactions.db
```

```sql
-- Example: Set AMAZON recipient #293 to use category 7 (same as #123)
UPDATE recipients SET default_category_id = 7 WHERE id = 293;
```

### 5. Run Again to Merge Remaining

After fixing categories, run the script again:

```bash
python -m utils.merge_recipients --dry-run  # Preview
python -m utils.merge_recipients            # Execute
```

## Advanced: Include Conflicting Merges

If you want to merge recipients with category conflicts (the script will use the primary recipient's category):

```bash
python -m utils.merge_recipients --include-conflicts --dry-run  # Preview
python -m utils.merge_recipients --include-conflicts            # Execute
```

⚠️ **Warning:** This will automatically choose one category and discard the others. Review carefully!

## Output Interpretation

### Merge Plan Section

```
MERGE PLAN
================================================================================
Total merge groups found: 45
Groups without conflicts: 40
Groups with conflicts (will be SKIPPED): 5
  Strategy: Merge non-conflicting recipients first
  Use --include-conflicts to merge conflicting groups too
```

This tells you:

- **40 groups** will be merged safely
- **5 groups** need manual review

### Completion Statistics

```
MERGE COMPLETE
================================================================================
Groups processed: 40
Groups skipped (conflicts): 5
Recipients merged: 78
Transactions reassigned: 3,456
```

- **Groups processed**: Successfully merged
- **Groups skipped**: Needs manual review
- **Recipients merged**: Total duplicate recipients removed
- **Transactions reassigned**: Total transactions updated

## Best Practice Workflow

1. **Dry run first**: Always preview with `--dry-run`
2. **Merge non-conflicts**: Run without flags to merge safe duplicates
3. **Review conflicts**: Check the skipped groups in the output
4. **Fix manually**: Update categories in database for conflicting groups
5. **Merge remaining**: Run again to merge the fixed groups
6. **Verify**: Check transaction counts before and after

## Example Complete Workflow

```bash
# Step 1: Preview everything
python -m utils.merge_recipients --dry-run

# Step 2: Merge non-conflicting (safe)
python -m utils.merge_recipients
# Enter 'yes' when prompted

# Step 3: Check database for conflicts
# (Review the "SKIPPED GROUPS" section from Step 2 output)

# Step 4: Fix conflicts manually
sqlite3 financial_transactions.db
# UPDATE recipients SET default_category_id = X WHERE id = Y;

# Step 5: Run again
python -m utils.merge_recipients --dry-run
python -m utils.merge_recipients
```

## Database File

The script uses the hardcoded database:

```
sqlite:///financial_transactions.db
```

Located at:

```
/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db
```

Always run the script from the backend directory!

