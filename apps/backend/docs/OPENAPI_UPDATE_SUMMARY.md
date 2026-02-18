# OpenAPI Specification Update Summary

**Date**: 2026-02-17  
**File**: `docs/openapi_spec.yaml`  
**Status**: ✅ Complete

## Overview

Updated the OpenAPI specification to include all currently existing API endpoints. Added comprehensive documentation for
two missing endpoint groups that were implemented in the codebase but not documented in the OpenAPI spec.

## Added Endpoints

### 1. Monthly Financial Summary Endpoint

**Endpoint**: `GET /api/info/monthly-summary`

Provides 6-month financial summary broken down month by month for trend analysis and budget tracking.

#### Features

- Month-by-month breakdown for the past 6 months
- Overall 6-month aggregate summary
- Optional category filtering to exclude specific categories (e.g., transfers)
- HATEOAS links for navigation
- Automatic period calculation

#### Query Parameters

- `excluded_category_ids` (optional): Array of category IDs to exclude from calculations
    - Default: [9, 22] (Intrabank and internal transfers)
    - Example: `?excluded_category_ids=9&excluded_category_ids=22`

#### Response Structure

Each month includes:

- Month number (1-12) and year
- Period start and end dates (ISO 8601)
- Total spending (negative amounts)
- Total income (positive amounts)
- Net amount (income + spending)
- Transaction count

Summary includes:

- Aggregate totals across all 6 months
- Total spending, income, net amount
- Total transaction count
- Overall period boundaries

#### Use Cases

- Monthly financial trend analysis
- Budget tracking and comparison
- Spending pattern identification
- Income vs expense analysis
- Financial reporting and dashboards

---

### 2. Transaction CSV Export Endpoints

**Endpoints**:

- `OPTIONS /api/transactions/export/csv` - Discover export capabilities
- `GET /api/transactions/export/csv` - Export transactions as CSV

#### Features

- Flexible filtering (same as transaction list endpoint)
- Standard CSV format compatible with Excel and other tools
- Automatic filename with timestamp
- Includes all transaction details and relationships
- Pagination support for large exports
- British English date format (DD/MM/YYYY)

#### Query Parameters (GET)

All standard transaction filters are supported:

- `limit` (default: 5000, max: 5000): Maximum transactions to export
- `offset` (default: 0): Number of transactions to skip
- `start_date` (optional): Start date filter (YYYY-MM-DD)
- `end_date` (optional): End date filter (YYYY-MM-DD)
- `bank_account` (optional): Filter by partial bank account match
- `category_id` (optional): Filter by category ID
- `recipient_id` (optional): Filter by recipient ID
- `recipient_name` (optional): Filter by partial recipient name match
- `uncategorised` (default: false): Filter for uncategorised transactions
- `active` (default: true): Filter by active status

#### CSV Columns

1. ID - Transaction identifier
2. Date - Transaction date (DD/MM/YYYY format)
3. Bank Account - Account name
4. Recipient - Recipient name
5. Memo - Transaction memo/description
6. Amount - Transaction amount
7. Currency - Currency code
8. Balance - Account balance after transaction
9. Category - Category name (GENERAL:DETAIL format)
10. Comment - Additional comments

#### Response Headers

- `Content-Disposition`: attachment; filename=transactions_YYYYMMDD_HHMMSS.csv
- `Content-Type`: text/csv; charset=utf-8

#### Use Cases

- Data backup and archival
- External analysis in Excel/Google Sheets
- Importing into other financial tools
- Audit trail and compliance reporting
- Offline transaction review

---

## New Schema Definitions

Added three new schema definitions to support the monthly summary endpoint:

### 1. MonthData

Represents financial data for a single month.

**Properties**:

- `month` (integer, 1-12): Month number
- `year` (integer, ≥2000): Year
- `period_start` (date): Start date of the month
- `period_end` (date): End date of the month
- `total_spending` (number, ≤0): Total spending (negative amounts)
- `total_income` (number, ≥0): Total income (positive amounts)
- `net_amount` (number): Net amount (income + spending)
- `transaction_count` (integer, ≥0): Number of transactions

### 2. SixMonthSummary

Represents overall summary for the 6-month period.

**Properties**:

- `total_spending` (number, ≤0): Total spending across all 6 months
- `total_income` (number, ≥0): Total income across all 6 months
- `net_amount` (number): Net amount across all 6 months
- `transaction_count` (integer, ≥0): Total transactions across all 6 months
- `period_start` (date): Start date of the 6-month period
- `period_end` (date): End date of the 6-month period

### 3. MonthlyFinancialSummaryResponse

Complete response for the monthly summary endpoint.

**Properties**:

- `months` (array of MonthData, 1-6 items): Monthly breakdown data
- `summary` (SixMonthSummary): Overall period summary
- `links` (array of Link): HATEOAS navigation links

---

## Validation

✅ **YAML Syntax**: Valid  
✅ **Schema Consistency**: All schemas properly referenced  
✅ **Line Count**: 4,870 lines (increased from 4,263 lines)  
✅ **Endpoint Count**: Now includes all implemented endpoints

---

## Technical Details

### File Statistics

- **Original Lines**: 4,263
- **Updated Lines**: 4,870
- **Added Lines**: 607
- **Location**: `/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/docs/openapi_spec.yaml`

### API Compliance

- **REST Level**: Level 3 (HATEOAS)
- **OpenAPI Version**: 3.1.0
- **British English**: Consistently used throughout
- **Response Models**: Pydantic v2 schemas referenced
- **HTTP Methods**: OPTIONS, GET properly documented
- **Status Codes**: Standard HTTP status codes with proper error responses

### Endpoint Organization

All endpoints are organized under the appropriate tags:

- `info` - Information and statistics endpoints
- `transactions` - Transaction management endpoints

### HATEOAS Implementation

Both new endpoint groups follow Level 3 REST API principles:

- OPTIONS endpoints for capability discovery
- Comprehensive HATEOAS links in all responses
- Self-documenting through hypermedia
- Clear relation types (self, parent, transactions, etc.)

---

## Verification Commands

```bash
# Validate YAML syntax
python3 -c "import yaml; yaml.safe_load(open('docs/openapi_spec.yaml')); print('✓ YAML syntax is valid')"

# Check line count
wc -l docs/openapi_spec.yaml

# Verify endpoints were added
grep "/api/info/monthly-summary:" docs/openapi_spec.yaml
grep "/api/transactions/export/csv:" docs/openapi_spec.yaml
```

---

## Next Steps

The OpenAPI specification is now complete and includes all currently implemented endpoints. Consider:

1. **API Documentation UI**: Deploy the spec with Swagger UI or ReDoc for interactive documentation
2. **Client Generation**: Use the spec to generate client SDKs for various languages
3. **Contract Testing**: Implement contract testing to ensure API matches the spec
4. **Version Control**: Consider semantic versioning for the API specification
5. **Changelog**: Maintain a changelog for API specification updates

---

## Related Documentation

- `/docs/INFO_ENDPOINTS_DOCUMENTATION.md` - Detailed info endpoint documentation
- `/docs/HTTP_PARAMETER_USAGE_GUIDELINES.md` - Parameter usage patterns
- `/docs/LEVEL3_REST_API_COMPLIANCE.md` - Level 3 REST API implementation guide
- `/docs/OPENAPI_DOCUMENTATION.md` - OpenAPI documentation overview

---

## Conclusion

The OpenAPI specification has been successfully updated with comprehensive documentation for all existing API endpoints.
The specification maintains consistency with the codebase, follows Level 3 REST API (HATEOAS) principles, and provides
clear, detailed documentation for API consumers.

All endpoints now have:

- Complete parameter documentation
- Example requests and responses
- Error response schemas
- HATEOAS link definitions
- Use case descriptions
- Feature highlights

The specification is production-ready and can be used for:

- API documentation generation
- Client SDK generation
- Contract testing
- Developer onboarding
- API governance

