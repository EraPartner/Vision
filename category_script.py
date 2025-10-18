import csv
import sqlite3
import difflib
from typing import Dict, Tuple, List

# Belgian merchant keywords for autocategorization
BELGIAN_MERCHANTS = {
    # Supermarkets & Food
    'Colruyt': ('Food', 'Supermarket'),
    'Delhaize': ('Food', 'Supermarket'),
    'Carrefour': ('Food', 'Supermarket'),
    'Lidl': ('Food', 'Supermarket'),
    'Aldi': ('Food', 'Supermarket'),
    'Spar': ('Food', 'Supermarket'),
    'Okay': ('Food', 'Supermarket'),
    'Delitraiteur': ('Food', 'Supermarket'),
    'Bio-Planet': ('Food', 'Supermarket'),
    'Smatch': ('Food', 'Supermarket'),
    # Gas Stations
    'Q8': ('Transport', 'Gas Station'),
    'TotalEnergies': ('Transport', 'Gas Station'),
    'Esso': ('Transport', 'Gas Station'),
    'Dats24': ('Transport', 'Gas Station'),
    'Texaco': ('Transport', 'Gas Station'),
    'Avia': ('Transport', 'Gas Station'),
    # Retail & Shopping
    'Krëfel': ('Shopping', 'Electronics'),
    'Dreamland': ('Shopping', 'Toys'),
    'HEMA': ('Shopping', 'General'),
    'JBC': ('Shopping', 'Clothing'),
    'Torfs': ('Shopping', 'Shoes'),
    'Schoemania': ('Shopping', 'Shoes'),
    'Casa': ('Shopping', 'Home'),
    'Action': ('Shopping', 'Discount'),
    'Zeeman': ('Shopping', 'Clothing'),
    'Wibra': ('Shopping', 'Discount'),
    'Blokker': ('Shopping', 'Home'),
    'Fnac': ('Shopping', 'Electronics'),
    'Coolblue': ('Shopping', 'Electronics'),
    'C&A': ('Shopping', 'Clothing'),
    'H&M': ('Shopping', 'Clothing'),
    'Primark': ('Shopping', 'Clothing'),
    'IKEA': ('Shopping', 'Home'),
    # DIY & Home
    'Brico': ('Home', 'DIY'),
    'Hubo': ('Home', 'DIY'),
    'Gamma': ('Home', 'DIY'),
    'Aveve': ('Home', 'Garden'),
    'Makro': ('Home', 'Wholesale'),
    'Praxis': ('Home', 'DIY'),
    # Pharmacies & Health
    'Multipharma': ('Health', 'Pharmacy'),
    'Medi-Market': ('Health', 'Pharmacy'),
    'iU': ('Health', 'Pharmacy'),
    # Transport & Mobility
    'SNCB': ('Transport', 'Train'),
    'NMBS': ('Transport', 'Train'),
    'De Lijn': ('Transport', 'Bus'),
    'TEC': ('Transport', 'Bus'),
    'STIB': ('Transport', 'Metro'),
    'MIVB': ('Transport', 'Metro'),
    'Cambio': ('Transport', 'Car Sharing'),
    'VAB': ('Transport', 'Road Assistance'),
    # Telecom & Utilities
    'Proximus': ('Utilities', 'Telecom'),
    'Orange': ('Utilities', 'Telecom'),
    'Base': ('Utilities', 'Telecom'),
    'Telenet': ('Utilities', 'Telecom'),
    'Voo': ('Utilities', 'Telecom'),
    'Luminus': ('Utilities', 'Energy'),
    'Engie': ('Utilities', 'Energy'),
    # Restaurants & Cafés
    'Exki': ('Food', 'Restaurant'),
    'Quick': ('Food', 'Fast Food'),
    'Lunch Garden': ('Food', 'Restaurant'),
    'Panos': ('Food', 'Bakery'),
    'Le Pain Quotidien': ('Food', 'Bakery'),
    # Banks
    'Belfius': ('Finance', 'Bank'),
    'KBC': ('Finance', 'Bank'),
    'ING': ('Finance', 'Bank'),
    'BNP Paribas': ('Finance', 'Bank'),
    # Existing
    'Decathlon': ('Shopping', 'Sports'),
    'MediaMarkt': ('Shopping', 'Electronics'),
    'ZEB': ('Shopping', 'Clothing'),
    'Colruyt Group': ('Food', 'Supermarket'),
    'Delhaize Group': ('Food', 'Supermarket'),
}

DB_PATH = 'financial_transactions.db'

# --- Category Import ---
def import_category_mappings(csv_path: str) -> Dict[str, Tuple[str, str]]:
    """Import category mappings from CSV. Returns mapping: person -> (General, Detailed)"""
    mappings = {}
    with open(csv_path, newline='', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            person = row['person']
            category = row['category']
            if ':' in category:
                general, detailed = category.split(':', 1)
            else:
                general, detailed = category, ''
            mappings[person] = (general.strip(), detailed.strip())
    return mappings

# --- Database Update ---
def update_transaction_categories(mappings: Dict[str, Tuple[str, str]]):
    """Update transactions in DB with new categories."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    for person, (general, detailed) in mappings.items():
        cur.execute("""
            UPDATE transactions SET category_general=?, category_detailed=? WHERE person=?
        """, (general, detailed, person))
    conn.commit()
    conn.close()

# --- Autocategorization ---
def autocategorize_transaction(description: str) -> Tuple[str, str]:
    """Return (General, Detailed) category for a transaction description."""
    # Fuzzy match against Belgian merchants
    for merchant, (general, detailed) in BELGIAN_MERCHANTS.items():
        if merchant.lower() in description.lower():
            return general, detailed
    # Fuzzy match with difflib for near matches
    close_matches = difflib.get_close_matches(description, BELGIAN_MERCHANTS.keys(), n=1, cutoff=0.8)
    if close_matches:
        merchant = close_matches[0]
        return BELGIAN_MERCHANTS[merchant]
    return 'Uncategorized', ''

# --- Add New Category ---
def add_new_category(person: str, general: str, detailed: str):
    """Add a new category mapping for a person."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        UPDATE transactions SET category_general=?, category_detailed=? WHERE person=?
    """, (general, detailed, person))
    conn.commit()
    conn.close()

# --- Assign Categories to Uncategorized Transactions ---
def assign_categories_to_uncategorized():
    """Find uncategorized transactions and suggest categories."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id, description FROM transactions WHERE category_general IS NULL OR category_general=''")
    rows = cur.fetchall()
    for tid, desc in rows:
        general, detailed = autocategorize_transaction(desc)
        cur.execute("UPDATE transactions SET category_general=?, category_detailed=? WHERE id=?", (general, detailed, tid))
    conn.commit()
    conn.close()

# --- Efficient Category Addition ---
def efficient_add_categories(new_mappings: Dict[str, Tuple[str, str]]):
    """Efficiently add/update multiple category mappings."""
    update_transaction_categories(new_mappings)

# --- Usage Example ---
if __name__ == '__main__':
    # Import mappings from CSV and update DB
    mappings = import_category_mappings('category_mappings_template.csv')
    update_transaction_categories(mappings)
    # Assign categories to uncategorized transactions
    assign_categories_to_uncategorized()
    # Add a new category for a person
    # add_new_category('John Doe', 'Food', 'Meat')
    # Efficiently add categories
    # efficient_add_categories({'Jane Doe': ('Transport', 'Train')})
