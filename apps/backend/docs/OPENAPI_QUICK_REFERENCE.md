# OpenAPI Specification Quick Reference

**Last Updated**: 2026-02-17  
**File**: `docs/openapi_spec.yaml`  
**Version**: 1.0.0  
**Total Endpoints**: 21

---

## Quick Stats

- **Total Endpoints**: 21
- **Total Schemas**: 38
- **Total Lines**: 4,870
- **OpenAPI Version**: 3.1.0
- **REST Level**: Level 3 (HATEOAS)
- **Language**: British English

---

## API Endpoints by Category

### 🏠 Root (1)

- `GET /api/` - API root discovery

### ⚙️ Admin (3)

- `GET /api/admin` - Database status
- `POST /api/admin/database/init` - Initialise database
- `POST /api/admin/database/reset` - Reset database

### 📁 Categories (3)

- `GET /api/categories` - List categories
- `POST /api/categories` - Create category
- `GET /api/categories/{categoryId}` - Get category
- `PATCH /api/categories/{categoryId}` - Update category
- `DELETE /api/categories/{categoryId}` - Delete category
- `POST /api/categories/assign` - Assign category to recipients

### 👥 Recipients (2)

- `GET /api/recipients` - List recipients
- `POST /api/recipients` - Create recipient
- `GET /api/recipients/{recipientId}` - Get recipient
- `PATCH /api/recipients/{recipientId}` - Update recipient
- `DELETE /api/recipients/{recipientId}` - Delete recipient

### 💰 Transactions (3)

- `GET /api/transactions` - List transactions
- `POST /api/transactions` - Create transaction
- `GET /api/transactions/{transactionId}` - Get transaction
- `PATCH /api/transactions/{transactionId}` - Update transaction
- `DELETE /api/transactions/{transactionId}` - Delete transaction
- `GET /api/transactions/export/csv` - Export as CSV

### 📥 Import (4)

- `POST /api/import/csv` - Import CSV (predefined)
- `POST /api/import/csv/custom` - Import CSV (custom)
- `GET /api/import/batches` - List import batches
- `GET /api/import/batches/{batchId}` - Get import batch

### 📊 Info (5)

- `GET /api/info` - Overview statistics
- `GET /api/info/banks` - List bank accounts
- `GET /api/info/transaction-count` - Transaction count
- `GET /api/info/transaction-summary` - Transaction summary
- `GET /api/info/monthly-summary` - 6-month summary

---

## Recently Added (2026-02-17)

### ✨ New Endpoints

1. **GET /api/info/monthly-summary**
    - 6-month financial summary
    - Month-by-month breakdown
    - Excludable categories

2. **GET /api/transactions/export/csv**
    - Export transactions as CSV
    - All transaction filters supported
    - Timestamped filename

### ✨ New Schemas

1. **MonthData** - Single month financial data
2. **SixMonthSummary** - 6-month aggregate summary
3. **MonthlyFinancialSummaryResponse** - Complete response

---

## Common Patterns

### OPTIONS Endpoints

All collection and resource endpoints have OPTIONS methods for capability discovery.

### Query Parameters

Common parameters across endpoints:

- `limit` - Pagination limit
- `offset` - Pagination offset
- `active` - Active status filter

### HATEOAS Links

All responses include:

- `self` - Current resource
- `parent` - Parent collection
- `next` - Next page (if applicable)
- `prev` - Previous page (if applicable)

### Response Codes

- `200` - Success
- `201` - Created
- `400` - Bad request
- `404` - Not found
- `500` - Server error

---

## Tools & Validation

### View Documentation

```bash
# Using Swagger UI (Docker)
docker run -p 8080:8080 -e SWAGGER_JSON=/app/openapi_spec.yaml -v $(pwd)/docs:/app swaggerapi/swagger-ui

# Using ReDoc (Docker)
docker run -p 8080:80 -e SPEC_URL=/specs/openapi_spec.yaml -v $(pwd)/docs:/usr/share/nginx/html/specs redocly/redoc
```

### Validate Spec

```bash
# YAML syntax
python3 -c "import yaml; yaml.safe_load(open('docs/openapi_spec.yaml')); print('✓ Valid')"

# OpenAPI validation (requires openapi-spec-validator)
pip install openapi-spec-validator
openapi-spec-validator docs/openapi_spec.yaml
```

### Generate Client

```bash
# Install OpenAPI Generator
npm install @openapitools/openapi-generator-cli -g

# Generate TypeScript client
openapi-generator-cli generate -i docs/openapi_spec.yaml -g typescript-axios -o ./generated/typescript

# Generate Python client
openapi-generator-cli generate -i docs/openapi_spec.yaml -g python -o ./generated/python
```

---

## Development Workflow

### Adding New Endpoint

1. **Implement Route**
    - Add route handler in appropriate `api_routes_*.py`
    - Define request/response Pydantic models
    - Implement OPTIONS method

2. **Update OpenAPI Spec**
    - Add path definition
    - Document parameters
    - Define responses
    - Add schemas if needed

3. **Validate**
   ```bash
   python3 -c "import yaml; yaml.safe_load(open('docs/openapi_spec.yaml'))"
   ```

4. **Test**
    - Test endpoint manually
    - Verify OPTIONS response
    - Check HATEOAS links
    - Validate against spec

5. **Document**
    - Update OPENAPI_ENDPOINT_COVERAGE.md
    - Update relevant docs

---

## File Locations

```
backend/
├── docs/
│   ├── openapi_spec.yaml                 # Main OpenAPI specification
│   ├── OPENAPI_UPDATE_SUMMARY.md         # Update summary
│   ├── OPENAPI_ENDPOINT_COVERAGE.md      # Coverage verification
│   └── OPENAPI_QUICK_REFERENCE.md        # This file
├── api/
│   ├── api_schemas.py                    # Pydantic models
│   ├── api_routes_*.py                   # Route handlers
│   └── hateoas_links.py                  # HATEOAS link generation
└── main.py                               # FastAPI app
```

---

## Support Resources

- **OpenAPI Spec**: https://spec.openapis.org/oas/v3.1.0
- **FastAPI Docs**: https://fastapi.tiangolo.com/
- **Pydantic Docs**: https://docs.pydantic.dev/
- **HATEOAS**: https://en.wikipedia.org/wiki/HATEOAS

---

## Maintenance Checklist

- [ ] All endpoints have OPTIONS methods
- [ ] All responses include HATEOAS links
- [ ] All parameters documented with examples
- [ ] All schemas reference Pydantic models
- [ ] British English spelling consistent
- [ ] Examples provided for all endpoints
- [ ] Error responses documented
- [ ] YAML syntax valid
- [ ] Coverage document updated

---

## Contact

For questions or updates to this specification, refer to the project documentation or raise an issue in the repository.

**Repository**: https://github.com/EraPartner/Vault-Voyager-Vision
**License**: MIT

t