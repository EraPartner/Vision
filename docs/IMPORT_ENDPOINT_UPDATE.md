# Import Functionality Update Summary

## Changes Made

### Backend Changes

#### 1. Added `/api/info/supported-banks` Endpoint
- **File**: `apps/backend/api/api_routes_info.py`
- **Purpose**: Returns list of supported banks for CSV import (fetched from bank adapter configurations)
- **Response**: `{ "banks": ["revolut", "belfius", "kbc"] }`
- Added HATEOAS link to the info endpoint discovery
- **Note**: This is a NEW endpoint not in the original OpenAPI spec, added to dynamically expose supported banks

#### 2. Backend Import Endpoint (Existing)
- **Endpoint**: `POST /api/import/csv`
- **Method**: File upload with multipart/form-data
- **Parameters**: 
  - `file`: CSV file (multipart/form-data body)
  - `bank_name`: Bank name as query parameter (e.g., `?bank_name=belfius`)
- **Supported Banks** (from backend code): `revolut`, `belfius`, `kbc` (case-insensitive)
- **Response**: 
  ```json
  {
    "batch_id": "123",
    "imported": 145,
    "duplicates": 5,
    "total_processed": 150,
    "status": "completed",
    "message": "Import completed successfully",
    "links": [...]
  }
  ```

### Frontend Changes

#### 1. Updated API Client (`apps/frontend/src/lib/api.ts`)
- **Old Method**: `importCSV(csvContent: string, bankSource?: string)`
  - Sent CSV content as JSON string
  - Posted to `/api/import-csv`
  
- **New Method**: `importCSV(file: File, bankName: string)`
  - Sends file as multipart/form-data
  - Posts to `/api/import/csv?bank_name={bankName}`
  - Returns complete import result with batch_id, counts, etc.

- **New Method**: `getSupportedBanks()`
  - Fetches from `/api/info/supported-banks`
  - Returns list of supported banks

#### 2. Updated Import Page (`apps/frontend/src/pages/ImportPage.tsx`)
- Removed hardcoded `PRESET_BANKS` array
- Now fetches supported banks from backend API on component mount
- Capitalizes bank names for better display (Revolut, Belfius, Kbc)
- Updated `handleImport` to:
  - Pass File object directly instead of reading content
  - Use correct bank name parameter
  - Handle new response format with batch_id and detailed counts
  - Show improved toast messages with duplicate count
- Updated bank dropdown to use fetched `supportedBanks` list
- Added loading state for when banks are being fetched
- Removed unused `Separator` import

## How It Works Now

1. **Component Initialization**:
   - ImportPage mounts and fetches supported banks from `/api/info/supported-banks`
   - Banks are capitalized and displayed in the dropdown

2. **User Selects Bank**:
   - User can choose from:
     - Auto-detect (sends "generic" to backend)
     - Supported banks (Revolut, Belfius, Kbc)
     - Custom (user enters custom bank name)

3. **File Upload**:
   - User drags/drops or selects CSV file
   - File is validated client-side for CSV format

4. **Import Process**:
   - File and bank name sent to `/api/import/csv?bank_name={bank}`
   - Backend uses appropriate adapter based on bank name
   - Response includes detailed import statistics
   - Success toast shows imported count and duplicates skipped

## Benefits

1. **Backend-Driven**: Frontend dynamically adapts to available bank adapters
2. **Better Error Handling**: More detailed response from backend
3. **Proper File Upload**: Uses multipart/form-data instead of JSON
4. **Case-Insensitive**: Backend handles bank name case conversion
5. **Extensible**: Adding new bank adapters automatically shows in UI
6. **Better UX**: Shows detailed import results including duplicates and total processed

## Testing Recommendations

1. Test with a valid Belfius CSV file
2. Test with a valid Revolut CSV file
3. Test with a valid KBC CSV file
4. Test with Auto-detect option
5. Test with Custom bank name
6. Verify error handling for invalid files
7. Verify error handling for unsupported banks
8. Check that duplicate detection works correctly
9. Verify toast messages show correct counts

## Notes

- Backend supports case-insensitive bank names (converts to lowercase and replaces spaces with underscores)
- Maximum file size: 50MB
- Supported file type: CSV only
- Duplicate detection uses hash-based comparison (date, amount, recipient)
- All transactions in a batch are associated with batch_id for tracking
