# 🏦 Multi-Bank CSV Import - Quick Reference

## Supported Banks

| Bank | Auto-Detect | Key Features |
|------|-------------|--------------|
| **Chase** | ✅ | Transaction Date, Category columns |
| **Bank of America** | ✅ | Running Balance column |
| **Wells Fargo** | ✅ | Asterisk placeholders |
| **Capital One** | ✅ | Card No., Debit/Credit split |
| **Citi** | ✅ | Status column, Debit/Credit |
| **Discover** | ✅ | Trans. Date format |
| **American Express** | ✅ | Card Member, Account # |
| **Generic** | ✅ | Fallback for any CSV |

## Quick Start

### Import Your First CSV

```bash
1. Login to your Finance Tracker
2. Go to Dashboard
3. Find "Import Transactions" card
4. Select your bank (optional)
5. Upload CSV file
6. Done! ✨
```

### Test with Sample Data

```bash
# Sample files provided in backend/sample_csv/
- chase_sample.csv
- bank_of_america_sample.csv
- capital_one_sample.csv
- discover_sample.csv
- amex_sample.csv
- citi_sample.csv
```

## Common CSV Formats

### Format 1: Single Amount Column
```csv
Date,Description,Amount
10/01/2025,Starbucks,-5.50
10/05/2025,Salary,3500.00
```

### Format 2: Debit/Credit Columns
```csv
Date,Description,Debit,Credit
10/01/2025,Starbucks,5.50,
10/05/2025,Salary,,3500.00
```

### Format 3: Multiple Date Columns
```csv
Transaction Date,Post Date,Description,Amount
10/01/2025,10/02/2025,Starbucks,-5.50
```

## How Auto-Detection Works

```
Your CSV
    ↓
1. Check user-selected bank
    ↓
2. Analyze column names
    ↓
3. Match patterns to bank
    ↓
4. Use specific parser
    ↓
5. Fallback to generic if needed
    ↓
Your Transactions! 🎉
```

## Auto-Categorization

Transactions are automatically categorized:

- 🛒 **Groceries**: Whole Foods, Trader Joe's, Safeway, Costco
- 🍕 **Dining**: Starbucks, restaurants, DoorDash, Uber Eats
- 🚗 **Transportation**: Gas stations, Uber, Lyft, parking
- 💡 **Utilities**: Electric, water, internet, phone
- 🎬 **Entertainment**: Netflix, Spotify, Hulu, Disney+
- 🏥 **Healthcare**: CVS, Walgreens, pharmacies, doctors
- 🛍️ **Shopping**: Amazon, Target, Best Buy, malls
- 💰 **Income**: Salary, deposits (positive amounts)
- 📦 **Other**: Everything else

## File Requirements

✅ **Must Have:**
- CSV format (.csv)
- Header row with column names
- Date column
- Description/Merchant column
- Amount column (or Debit/Credit)

❌ **Not Required:**
- Specific column order
- Specific column names
- USD symbol ($)
- Specific date format

## Features

### Duplicate Prevention
- Checks: Date + Description + Amount
- Prevents re-importing same transaction
- Safe to re-upload same file

### Error Handling
- Skips invalid rows
- Continues processing valid data
- Reports number imported

### Multi-Bank Support
- Import from different banks
- Each transaction tagged with source
- Mix accounts in one dashboard

## Tips & Tricks

💡 **Best Practices:**
1. Export CSV from your bank's website
2. Don't edit the CSV file
3. Select your bank for best results
4. Import regularly (weekly/monthly)
5. Review transactions after import

⚠️ **Common Issues:**
- Excel changes date formats → Use bank's CSV directly
- Special characters → Keep original encoding (UTF-8)
- Multiple accounts → Import separately with bank name

## Adding Your Bank

If your bank isn't listed:

1. Try "Auto-detect" first (generic parser)
2. Use "Other/Custom" option
3. If issues persist, create custom parser (see MULTI_BANK_IMPORT.md)

## Examples

### Chase Bank
```csv
Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/01/2025,10/02/2025,WHOLE FOODS,Groceries,Sale,-45.32,
```

### Bank of America
```csv
Date,Description,Amount,Running Bal.
10/01/2025,TRADER JOES,-52.18,2500.00
```

### Capital One
```csv
Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
10/01/2025,10/02/2025,1234,SAFEWAY,Merchandise,43.76,
```

## API Usage

### Get Supported Banks
```bash
curl http://localhost:8000/api/supported-banks
```

### Import CSV (with auth)
```bash
curl -X POST http://localhost:8000/api/import-csv \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"csv_content": "...", "bank_source": "Chase"}'
```

## Need Help?

📖 **Full Documentation**: See `MULTI_BANK_IMPORT.md`
🐛 **Issues**: Check CSV format and try generic parser
🚀 **Custom Banks**: Add your own parser (5 minutes)

---

**Made with ❤️ for multi-bank tracking**
