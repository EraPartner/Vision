# Dashboard Statistics Update

## Summary
Updated the DashboardPage to use real-time statistics from `/api/info` endpoints instead of calculating values from fetched transactions.

## Changes Made

### DashboardPage.tsx
- **Replaced manual calculation** with `useDashboardStats()` hook
- Now fetches real-time data from:
  - `/api/info/transaction-count` - Total transactions across all time
  - `/api/info/monthly-summary` - Financial summary for last 30 days

### Real-time Statistics
The following stat cards now use live API data:

1. **Total Transactions**: From `/api/info/transaction-count`
   - Shows total count across entire database
   
2. **Total Spending**: From `/api/info/monthly-summary`
   - Shows spending for last 30 days
   - Subtitle: "Last 30 days"
   
3. **Total Income**: From `/api/info/monthly-summary`
   - Shows income for last 30 days
   - Subtitle: "Last 30 days"
   
4. **Net Balance**: From `/api/info/monthly-summary`
   - Calculated as `total_income + total_spending`
   - Dynamic subtitle based on positive/negative cash flow

### Benefits

1. **Accuracy**: Statistics are calculated server-side from complete database
2. **Performance**: No need to fetch all transactions just to calculate stats
3. **Consistency**: Same data source as other parts of the application
4. **Real-time**: Data updates with 30-second staleness (configured in `useDashboardStats`)
5. **Separation of Concerns**: Charts still use transaction data for detailed breakdowns

### Data Flow

```
DashboardPage
├── useDashboardStats() → Real-time API stats for stat cards
│   ├── /api/info/transaction-count
│   └── /api/info/monthly-summary
│
└── useTransactions() → Transaction data for charts & table
    └── /api/transactions?limit=50
```

### Implementation Details

The `useDashboardStats` hook (already existed):
- Uses React Query for caching and automatic refetching
- Combines data from two API endpoints
- Handles loading and error states
- Auto-refetches on window focus
- 30-second staleness time for freshness

### Testing
To verify the changes work correctly:
1. Start the backend: `cd apps/backend && uvicorn main:app --reload`
2. Start the frontend: `npm run dev`
3. Navigate to dashboard - stat cards should show real-time values
4. Import new transactions - stat cards should update automatically

## Notes
- Charts and recent transactions table still use transaction data for detailed breakdowns
- This is intentional as those require more granular data
- Future enhancement: Add endpoints for monthly chart data if needed
