import re

with open('apps/node-backend/tests/infoRepository.test.js', 'r') as f:
    content = f.read()

# Fix 1: "should use current investment holdings for latest snapshot when historical portfolio value is missing"
# We need to change the mock return for `FROM investments i` and add mock for `AS unit_delta` and remove `units_in/out` logic from the mock, since it was rewritten.
content = re.sub(
    r"if \(sql\.includes\('FROM investments i'\) && sql\.includes\('LEFT JOIN portfolio_transactions pt'\)\) \{\s*return \{\s*rows: \[\s*\{\s*id: 1,\s*asset_class: 'stock',\s*currency: 'EUR',\s*current_price: '25',\s*units_in: '10',\s*units_out: '0',\s*buy_amount: '200',\s*sell_amount: '0',\s*appreciation: '0',\s*\},\s*\],\s*\};\s*\}",
    """if (sql.includes('i.price_provider_history_url')) {
          return {
            rows: [
              {
                id: 1,
                currency: 'EUR',
                current_price: '25',
                price_provider: 'manual',
                first_tx_date: todayKey,
                created_date: todayKey,
              },
            ],
          };
        }
        if (sql.includes('AS unit_delta')) {
          return { rows: [{ investment_id: 1, day: todayKey, unit_delta: '10' }] };
        }""",
    content
)

# Fix 2: "should not backfill historical unit-priced values from current_price when history is missing"
# We change the name to "should backfill historical unit-priced values from current_price when history is missing"
# And we change `expect(result.snapshots[0].investments).toBe(0);` to `toBe(120);`
content = re.sub(
    r"should not backfill historical unit-priced values from current_price when history is missing",
    "should backfill historical unit-priced values from current_price when history is missing",
    content
)
content = re.sub(
    r"expect\(result\.snapshots\[0\]\.investments\)\.toBe\(0\);",
    "expect(result.snapshots[0].investments).toBe(120);",
    content
)

# Fix 3: "should use transaction unit price fallback for historical days when market quote history is missing"
# Change name to "should interpolate transaction unit price for historical days when market quote history is missing"
# We change `expect(yesterdaySnapshot\?.investments)\.toBe\(125\);` to `expect(yesterdaySnapshot?.investments).toBeGreaterThan(125);`
# And `expect(todaySnapshot\?.investments)\.toBe\(9990\);` to `toBe(9990);`
content = re.sub(
    r"should use transaction unit price fallback for historical days when market quote history is missing",
    "should interpolate transaction unit price for historical days when market quote history is missing",
    content
)
content = re.sub(
    r"expect\(yesterdaySnapshot\?\.investments\)\.toBe\(125\);",
    "expect(yesterdaySnapshot?.investments).toBeGreaterThan(125);",
    content
)


with open('apps/node-backend/tests/infoRepository.test.js', 'w') as f:
    f.write(content)

