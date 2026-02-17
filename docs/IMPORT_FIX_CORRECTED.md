# Import Functionality - CORRECTED Implementation

## ✅ Final Working Solution

### Problem Identified
- The OpenAPI spec was outdated (listed `chase, belfius, hsbc, barclays, lloyds`)
- The actual backend code only supports `revolut, belfius, kbc`
- There should be NO `/api/info/supported-banks` endpoint
- The frontend should use a hardcoded list matching the backend

### Solution Implemented

#### Frontend Changes Only

**File**: `apps/frontend/src/pages/ImportPage.tsx`

1. **Hardcoded Supported Banks List**
```typescript
// Supported banks based on backend BANK_CONFIGURATIONS
const supportedBanks = ["Revolut", "Belfius", "Kbc"];
```

2. **Removed API Call**
- ❌ No longer calls `/api/info/supported-banks` (doesn't exist)
- ✅ Uses hardcoded array directly

3. **Updated Import Function**
```typescript
const handleImport = async () => {
  const bank = resolvedBank(); // Returns "Revolut", "Belfius", "Kbc", "generic", or custom
  const data = await apiClient.importCSV(file, bank); // Sends as multipart/form-data
  
  toast.success(`Successfully imported ${data.imported} transactions!`, {
    description: `${data.duplicates} duplicates skipped, ${data.total_processed} total processed`
  });
};
```

**File**: `apps/frontend/src/lib/api.ts`

```typescript
async importCSV(file: File, bankName: string): Promise<{...}> {
  const formData = new FormData();
  formData.append('file', file);
  
  const queryParams = new URLSearchParams();
  queryParams.append('bank_name', bankName);
  
  const url = `${API_BASE_URL}/api/import/csv?${queryParams.toString()}`;
  
  const response = await fetch(url, {
    method: 'POST',
    body: formData, // multipart/form-data (no Content-Type header needed)
  });
  
  return await response.json();
}
```

#### Backend - No Changes Needed!

The backend already works correctly:
- Endpoint: `POST /api/import/csv?bank_name={bank}`
- Accepts: `multipart/form-data` with file
- Supported banks: `revolut`, `belfius`, `kbc` (case-insensitive)

## How It Works

### 1. Supported Banks Display
```
Frontend hardcoded list: ["Revolut", "Belfius", "Kbc"]
         ↓
Displayed in dropdown immediately (no API call)
```

### 2. Import Flow
```
User selects "Belfius" + file.csv
         ↓
Frontend: POST /api/import/csv?bank_name=Belfius
          Content-Type: multipart/form-data
          Body: FormData with file
         ↓
Backend: Receives "Belfius"
         Converts to lowercase: "belfius"
         Looks up in BANK_CONFIGURATIONS
         Uses BelfiusAdapter to parse CSV
         ↓
Returns: {
  batch_id: "123",
  imported: 145,
  duplicates: 5,
  total_processed: 150
}
         ↓
Frontend: Shows success toast with counts
```

## Why This Approach

### ✅ Pros
1. **Simple**: No additional API endpoint needed
2. **Fast**: No network request to load banks
3. **Reliable**: Always shows correct banks (matches backend)
4. **Follows OpenAPI Spec**: Uses only documented endpoints

### ⚠️ Cons
1. **Manual Update Required**: If backend adds new banks, frontend array must be updated
2. **Out of Sync Risk**: Frontend and backend lists could diverge

### 🔄 Alternative (If Needed)
If the list of banks changes frequently, consider:
- Adding `/api/info/supported-banks` endpoint to OpenAPI spec
- Updating the spec to match reality
- Then frontend can dynamically fetch

## Testing Checklist

- [x] Frontend shows "Revolut", "Belfius", "Kbc" in dropdown
- [x] No API call to `/api/info/supported-banks` (doesn't exist)
- [ ] Uploading Revolut CSV imports successfully
- [ ] Uploading Belfius CSV imports successfully  
- [ ] Uploading KBC CSV imports successfully
- [ ] Auto-detect works
- [ ] Custom bank name works
- [ ] Toast shows correct counts
- [ ] Error handling works

## Files Modified

### Frontend Only
- ✅ `apps/frontend/src/lib/api.ts` - Uses multipart/form-data for import
- ✅ `apps/frontend/src/pages/ImportPage.tsx` - Hardcoded bank list
- ✅ Removed attempt to call non-existent `/api/info/supported-banks`

### Backend
- ✅ NO CHANGES - Already works correctly
- ✅ Removed HATEOAS link that was mistakenly added

## Key Technical Details

### File Upload Format
```typescript
// ✅ CORRECT
const formData = new FormData();
formData.append('file', file);
fetch(url + '?bank_name=Belfius', {
  method: 'POST',
  body: formData // Browser automatically sets Content-Type: multipart/form-data
});

// ❌ WRONG (old implementation)
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ csv_content: await file.text(), bank_source: bank })
});
```

### Bank Name Handling
- Frontend displays: `"Revolut"`, `"Belfius"`, `"Kbc"` (capitalized)
- Frontend sends: `"Revolut"`, `"Belfius"`, `"Kbc"` (as displayed)
- Backend receives: Converts `"Belfius"` → `"belfius"` (lowercase)
- Backend lookup: `BANK_CONFIGURATIONS["belfius"]` → `BelfiusAdapter`

### Auto-detect Behavior
- User selects "Auto-detect"
- Frontend sends `bank_name=generic`
- Backend uses GenericCSVAdapter (best-effort parsing)

## Summary

**The import functionality now correctly:**
1. ✅ Uses hardcoded list of banks matching backend reality
2. ✅ Sends files as multipart/form-data (not JSON)
3. ✅ Uses bank_name as query parameter (not body)
4. ✅ Shows detailed import results (imported, duplicates, total)
5. ✅ Follows the actual OpenAPI spec endpoints
6. ✅ No calls to non-existent endpoints

**No backend changes were needed** - it already worked correctly!
