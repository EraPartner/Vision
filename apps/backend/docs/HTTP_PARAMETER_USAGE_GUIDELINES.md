# HTTP Parameter Usage Guidelines

## HTTP Parameter Usage Patterns for Financial Transaction APIs

This document provides comprehensive guidelines for proper HTTP parameter usage following REST conventions and financial
application best practices.

## Query Parameters - Use for:

### 1. **Filtering & Search**

Optional filters that modify the result set

- **Example**: `GET /api/categories?general=groceries&detail=food`
- **Benefits**: Bookmarkable URLs, cacheable, transparent filtering

### 2. **Pagination**

Control over result set size and navigation

- **Example**: `GET /api/categories?limit=50&offset=100`
- **Benefits**: Consistent pagination, URL-based navigation

### 3. **Sorting**

Optional sort parameters

- **Example**: `GET /api/categories?sort=general_asc`
- **Benefits**: Flexible ordering, stateless sorting

### 4. **Optional Modifiers**

Parameters that modify behaviour but aren't core data

- **Example**: `GET /api/categories/{id}?include_inactive=true`
- **Benefits**: Backwards compatibility, optional features

## Body Parameters - Use for:

### 1. **Resource Creation (POST)**

Structured data forming new entities

- **Example**: `POST /api/categories` with JSON body
- **Benefits**: Clear schema, validation, extensibility

### 2. **Resource Updates (PATCH/PUT)**

Modification data for existing entities

- **Example**: `PATCH /api/categories/{id}` with JSON body
- **Benefits**: Partial updates, clear change tracking

### 3. **Complex Operations**

Multi-step operations with structured input

- **Example**: `POST /api/categories/assign` with category and recipient data
- **Benefits**: Atomic operations, clear data relationships

### 4. **Sensitive Data**

Information that shouldn't appear in URLs/logs

- **Example**: Authentication tokens, personal data
- **Benefits**: Security, audit compliance

## Path Parameters - Use for:

### 1. **Resource Identification**

Unique identifiers in the URL path

- **Example**: `GET /api/categories/{category_id}`
- **Benefits**: RESTful resource addressing, clear hierarchy

### 2. **Required Navigation**

Essential parts of the resource location

- **Example**: `GET /api/categories/{general}/{detail}` (deprecated - now use filters)
- **Benefits**: Hierarchical access, required parameters

## Decision Matrix

| Use Case                     | Parameter Type   | Rationale                            |
|------------------------------|------------------|--------------------------------------|
| **Optional + Filtering**     | Query Parameters | Bookmarkable, cacheable, transparent |
| **Required + Resource Data** | Body Parameters  | Structured, validated, extensible    |
| **Required + Resource ID**   | Path Parameters  | RESTful addressing, clear hierarchy  |
| **Pagination/Sorting**       | Query Parameters | Standard REST conventions            |
| **Complex Structured Data**  | Body Parameters  | JSON validation, clear schema        |

## Examples by Endpoint Type

### Collection Endpoints (GET /api/resources)

```http
# Filtering and pagination - Query Parameters
GET /api/categories?general=groceries&limit=50&offset=100

# Why Query: Optional filters, bookmarkable, cacheable
```

### Resource Creation (POST /api/resources)

```http
# Resource data - Body Parameters
POST /api/categories
Content-Type: application/json

{
    "general": "groceries",
    "detail": "food",
    "description": "Food and grocery purchases",
    "color": "#FF5733"
}

# Why Body: Structured data, validation, extensibility
```

### Resource Updates (PATCH /api/resources/{id})

```http
# Modification data - Body Parameters
PATCH /api/categories/5
Content-Type: application/json

{
    "color": "#00FF00",
    "description": "Updated description"
}

# Why Body: Partial updates, clear change tracking
```

### Complex Operations (POST /api/resources/action)

```http
# Multi-entity operations - Body Parameters
POST /api/categories/assign
Content-Type: application/json

{
    "category_general": "groceries",
    "category_detail": "food", 
    "recipient_ids": [1, 2, 3, 4]
}

# Why Body: Atomic operations, related data grouping
```

## Anti-Patterns to Avoid

### ❌ Resource Creation with Query Parameters

```http
# BAD: Resource data in URL
POST /api/categories?general=groceries&detail=food&description=Long%20description

# Problems: URL length limits, poor readability, no validation
```

### ❌ Filtering with Body Parameters

```http
# BAD: Filters in request body
POST /api/categories/search
{
    "general_filter": "groceries",
    "limit": 50
}

# Problems: Not cacheable, not bookmarkable, non-standard
```

### ❌ Required IDs in Query Parameters

```http
# BAD: Resource ID in query
GET /api/categories?id=5

# Should be: GET /api/categories/5
```

## Financial API Specific Considerations

### Audit Requirements

- Query parameters are logged for audit trails
- Body parameters may contain sensitive financial data
- Use appropriate parameter type based on sensitivity

### Security

- Sensitive data (account numbers, amounts) → Body parameters
- Filtering criteria → Query parameters
- Resource identifiers → Path parameters

### Performance

- Query parameters enable HTTP caching
- Body parameters require request parsing
- Choose based on performance requirements

### Compliance

- Financial APIs require comprehensive logging
- Parameter choices affect log readability
- Consider regulatory reporting needs

## British English Terminology

Maintain consistency throughout the API:

- colour (not color)
- categorisation (not categorization)
- realise (not realize)
- initialise (not initialize)

## Implementation Guidelines

### 1. **Always Validate**

All parameters should have appropriate validation regardless of type

### 2. **Document Clearly**

Each parameter should have clear documentation explaining its purpose

### 3. **Follow Conventions**

Stick to established REST conventions for consistency

### 4. **Consider Future Extensions**

Choose parameter types that allow for future API enhancements

### 5. **Test Thoroughly**

Test all parameter combinations and edge cases

## Related Documentation

- [Category API Refactoring](./CATEGORY_API_REFACTORING.md)
- [OpenAPI Improvements Summary](./OPENAPI_IMPROVEMENTS_SUMMARY.md)
- [REST API Levels Guide](./REST_API_LEVELS.md)
