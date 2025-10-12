# Multi-Bank CSV Import System

## Overview

The Finance Tracker now supports importing CSV files from multiple banks with bank-specific parsers that understand each institution's unique format. The system automatically detects the bank format or you can manually specify your bank for optimal parsing.

## Supported Banks

### Currently Implemented Parsers

1. **Chase Bank**
   - Format: Transaction Date, Post Date, Description, Category, Type, Amount, Memo
   - Auto-detects based on column structure

2. **Bank of America**
   - Format: Date, Description, Amount, Running Bal.
   - Identifies by "Running Bal." column

3. **Wells Fargo**
   - Format: Date, Amount, *, *, Description
   - Handles asterisk placeholders for check numbers

4. **Capital One**
   - Format: Transaction Date, Posted Date, Card No., Description, Category, Debit, Credit
   - Identifies by "Card No." column
   - Properly handles separate Debit/Credit columns

5. **Citi Bank**
   - Format: Status, Date, Description, Debit, Credit
   - Identifies by "Status" column
   - Handles Debit/Credit column structure

6. **Discover Card**
   - Format: Trans. Date, Post Date, Description, Amount, Category
   - Identifies by "Trans. Date" format

7. **American Express (Amex)**
   - Format: Date, Description, Card Member, Account #, Amount
   - Identifies by "Card Member" column

8. **Generic Parser**
   - Fallback parser for banks not specifically listed
   - Intelligently detects common column patterns
   - Works with most standard CSV formats

## How It Works

### 1. Automatic Detection

The system uses a smart detection algorithm:

```
CSV File → Parser Manager → Detect Bank Type → Route to Parser → Extract Transactions
```

Detection methods (in order):
1. **User Hint**: If you select a bank, we use that parser
2. **Column Structure**: Analyzes column names and patterns
3. **Generic Fallback**: If no match, uses the generic parser

### 2. Bank-Specific Parsing

Each parser handles:
- **Date Formats**: Various date column names and formats
- **Amount Handling**: Single amount, or separate debit/credit columns
- **Description Extraction**: Merchant name parsing
- **Sign Convention**: Some banks use negative for debits, others separate columns

### 3. Auto-Categorization

All parsers include smart categorization:
- **Groceries**: Whole Foods, Trader Joe's, Safeway, Costco, etc.
- **Dining**: Starbucks, McDonald's, restaurants, DoorDash, etc.
- **Transportation**: Gas stations, Uber, Lyft, parking, etc.
- **Utilities**: Electric, water, internet, phone bills
- **Entertainment**: Netflix, Spotify, Hulu, movies
- **Healthcare**: Pharmacies, hospitals, medical services
- **Shopping**: Amazon, Target, Best Buy, etc.
- **Income**: Positive amounts (salary, deposits)
- **Other**: Everything else

## Usage

### From the Web Interface

1. **Navigate to Dashboard**
2. **Click CSV Import Card**
3. **Select Your Bank** (optional but recommended)
4. **Choose File** from your computer
5. **Upload** - The system will:
   - Detect your bank format
   - Parse all transactions
   - Categorize automatically
   - Check for duplicates
   - Import new transactions

### Example CSV Formats

Sample CSV files are provided in `backend/sample_csv/`:
- `chase_sample.csv`
- `bank_of_america_sample.csv`
- `capital_one_sample.csv`
- `discover_sample.csv`
- `amex_sample.csv`
- `citi_sample.csv`

## Adding a New Bank Parser

### Step 1: Create Parser Class

Edit `backend/bank_parsers.py`:

```python
class MyBankParser(BankParser):
    """Parser for My Bank CSV format"""
    
    def get_bank_name(self) -> str:
        return "My Bank"
    
    def parse(self, csv_content: str) -> List[Dict]:
        df = pd.read_csv(StringIO(csv_content))
        transactions = []
        
        for _, row in df.iterrows():
            try:
                # Parse your bank's specific format
                trans_date = pd.to_datetime(row['YourDateColumn']).date()
                description = str(row['YourDescColumn']).strip()
                amount = float(str(row['YourAmountColumn']).replace('$', ''))
                
                category = self.categorize_transaction(description, amount)
                
                transactions.append({
                    'transaction_date': trans_date,
                    'description': description,
                    'amount': amount,
                    'category': category,
                    'bank_source': self.get_bank_name()
                })
            except Exception:
                continue
        
        return transactions
```

### Step 2: Register Parser

Edit `backend/csv_parser_manager.py`:

```python
def __init__(self):
    self.parsers = {
        # ...existing parsers...
        'my_bank': MyBankParser(),
    }
```

### Step 3: Add Detection Logic

Add detection in `detect_bank_type()`:

```python
def detect_bank_type(self, csv_content: str, bank_hint: Optional[str] = None) -> BankParser:
    # ...existing code...
    
    # My Bank: Has unique column
    if 'my_banks_unique_column' in columns:
        return self.parsers['my_bank']
```

### Step 4: Test with Sample CSV

1. Create `backend/sample_csv/my_bank_sample.csv`
2. Test import through the web interface
3. Verify transactions are parsed correctly

## API Endpoints

### Get Supported Banks
```http
GET /api/supported-banks
```

Response:
```json
{
  "banks": [
    "Chase",
    "Bank of America",
    "Wells Fargo",
    ...
  ]
}
```

### Import CSV
```http
POST /api/import-csv
Authorization: Bearer <token>
Content-Type: application/json

{
  "csv_content": "Date,Description,Amount\n...",
  "bank_source": "Chase"  // optional
}
```

Response:
```json
{
  "imported": 25,
  "message": "Successfully imported 25 transactions"
}
```

## Features

### ✅ Duplicate Detection
The system automatically prevents importing the same transaction twice by checking:
- Transaction date
- Description
- Amount

### ✅ Error Handling
- Skips invalid rows without failing entire import
- Provides clear error messages
- Rolls back on critical errors

### ✅ Flexible Parsing
- Handles various date formats
- Currency symbols ($, commas)
- Different amount representations (negative, separate columns)
- Extra columns are ignored

### ✅ Smart Categorization
- 9 transaction categories
- 100+ merchant patterns
- Context-aware (amount sign)
- Easily extensible

## Troubleshooting

### CSV Won't Import
1. Check file encoding (should be UTF-8)
2. Ensure first row is headers
3. Verify date format is parseable
4. Try selecting bank manually

### Wrong Categories
- Edit `bank_parsers.py` → `categorize_transaction()`
- Add your merchants to patterns
- Categories: groceries, dining, transportation, utilities, entertainment, healthcare, shopping, income, other

### Duplicates Imported
This shouldn't happen, but if it does:
- System checks date + description + amount
- Slight variations create new entries
- You can manually delete duplicates from UI

### Custom Bank Format
1. Use "Other/Custom" option
2. Generic parser handles most formats
3. If issues persist, create a custom parser (see above)

## Best Practices

1. **Download from Bank**: Export recent transactions as CSV
2. **Check Format**: Open in text editor to verify structure
3. **Select Bank**: Choose your bank from dropdown for best results
4. **Review Import**: Check dashboard after import
5. **Delete Errors**: Remove any incorrectly parsed transactions
6. **Regular Imports**: Import monthly for best tracking

## Future Enhancements

Potential additions:
- [ ] QFX/OFX file support
- [ ] PDF statement parsing
- [ ] Plaid API integration
- [ ] International bank formats
- [ ] Custom category rules per user
- [ ] Merchant name normalization
- [ ] Recurring transaction detection
