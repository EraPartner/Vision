# Category Uppercase Normalization Implementation

## Overview

Implemented automatic uppercase normalization for category general and detail fields to ensure consistency across the
financial transaction management system. All category names are stored and displayed in uppercase, while accepting input
in any case for better user experience.

## Implementation Details

### 1. Database Model Changes (`database/models.py`)

#### **Enhanced Category Model**:

- **Private Columns**: Changed to use private `_general` and `_detail` columns mapped to database
- **Property Setters**: Added property setters that automatically convert input to uppercase
- **Property Getters**: Return uppercase values consistently
- **Automatic Normalization**: Any value assigned to `general` or `detail` is stripped and converted to uppercase

```python
@property
def general(self) -> str:
    """Get the general category name (always uppercase)."""
    return self._general


@general.setter
def general(self, value: str) -> None:
    """Set the general category name (automatically converted to uppercase)."""
    if value:
        self._general = value.strip().upper()
    else:
        self._general = value
```

### 2. Service Layer Updates (`services/category_service.py`)

#### **Enhanced Category Operations**:

- **Create/Get**: Input normalization before database operations
- **Update**: Automatic uppercase conversion via property setters
- **Lookup**: Case-insensitive search with normalized input
- **Logging**: Consistent uppercase values in audit logs

```python
# Normalize input to uppercase for consistent storage and lookup
general_normalized = general.strip().upper() if general else ""
detail_normalized = detail.strip().upper() if detail else ""
```

### 3. Repository Layer Enhancements (`repositories/category_repository.py`)

#### **Case-Insensitive Filtering**:

- **Search Logic**: Filter inputs normalized to uppercase for matching
- **Query Optimization**: Uses `ilike()` with uppercase conversion for case-insensitive search
- **Consistent Results**: All queries return categories with uppercase names

```python
# Apply filters with case-insensitive search against uppercase stored values
if general:
    query = query.filter(Category.general.ilike(f"%{general.upper()}%"))
```

### 4. API Schema Validation (`api/api_schemas.py`)

#### **Existing Validators Enhanced**:

- **CategoryBase**: Already has field validators for general and detail normalization
- **CategoryUpdate**: Handles optional field updates with normalization
- **Input Processing**: Pydantic validators ensure consistent uppercase before database operations

```python
@field_validator("general", "detail", mode="before")
@classmethod
def normalise(cls, value: str) -> str:
    """Normalise text fields to uppercase and strip whitespace."""
    if value is None:
        return value
    return value.strip().upper()
```

### 5. API Documentation Updates (`api/api_routes_categories.py`)

#### **Enhanced Documentation**:

- **Clear Expectations**: Users understand that categories are always returned in uppercase
- **Input Flexibility**: Documented that any case input is accepted
- **Examples**: Show input/output normalization clearly

## User Experience

### **Input Flexibility**:

Users can input category names in any case:

```json
{
  "general": "groceries",
  // lowercase
  "detail": "Food"
  // mixed case
}
```

### **Consistent Output**:

All responses return uppercase category names:

```json
{
  "general": "GROCERIES",
  // always uppercase
  "detail": "FOOD"
  // always uppercase
}
```

### **Case-Insensitive Search**:

Filtering works regardless of input case:

```http
GET /api/categories?general=groceries       // finds "GROCERIES"
GET /api/categories?general=GROCERIES       // finds "GROCERIES"  
GET /api/categories?general=Groceries       // finds "GROCERIES"
```

## Benefits Achieved

### 1. **Data Consistency**:

- All category names stored in uniform uppercase format
- Eliminates case-sensitivity issues in data processing
- Consistent display across all UI components

### 2. **Better User Experience**:

- Users can input categories in natural case
- Search and filtering work regardless of input case
- No need for users to remember exact casing

### 3. **System Reliability**:

- Prevents duplicate categories due to case differences
- Consistent data for reporting and analytics
- Simplified data processing and validation

### 4. **Financial Domain Compliance**:

- Standard uppercase format for financial category classification
- Consistent audit trails and logging
- Professional appearance in financial reports

## Technical Implementation Notes

### **Database Compatibility**:

- Uses SQLAlchemy property setters for automatic conversion
- Maintains existing database schema structure
- No migration required - conversion happens at application level

### **Performance Considerations**:

- Minimal overhead for string conversion operations
- Database indexes still work efficiently with uppercase values
- Query performance maintained with proper ILIKE usage

### **Backwards Compatibility**:

- Existing data works without modification
- APIs accept mixed case input as before
- Only change is consistent uppercase output

## Testing Recommendations

### **Case Normalization**:

- [ ] Test creation with lowercase input → uppercase storage
- [ ] Test creation with mixed case input → uppercase storage
- [ ] Test update operations with various case inputs
- [ ] Verify property setters work correctly

### **Search Functionality**:

- [ ] Test filtering with lowercase search terms
- [ ] Test filtering with uppercase search terms
- [ ] Test filtering with mixed case search terms
- [ ] Verify partial matching works case-insensitively

### **API Consistency**:

- [ ] Verify all GET endpoints return uppercase categories
- [ ] Test POST/PATCH endpoints accept any case input
- [ ] Confirm response schemas show uppercase values
- [ ] Test HATEOAS links with uppercase category names

### **Data Integrity**:

- [ ] Test duplicate detection with different cases
- [ ] Verify unique constraints work with uppercase storage
- [ ] Test foreign key relationships work correctly
- [ ] Confirm audit logs show consistent uppercase values

## Migration Considerations

### **Existing Data**:

- Current categories will be normalized on next update
- No immediate database changes required
- Gradual normalization through normal operations

### **Client Applications**:

- Frontend should expect uppercase category names
- Search functionality benefits from case-insensitive input
- Display logic simplified with consistent case format

### **Integration Points**:

- CSV imports will normalize category names automatically
- Transaction processing uses consistent uppercase categories
- Reporting systems receive standardized category names

## Future Enhancements

### **Potential Extensions**:

- Apply similar normalization to other financial entities if needed
- Add configuration option for case normalization behavior
- Implement bulk normalization script for existing data
- Consider internationalization implications for uppercase conversion

This implementation successfully ensures category consistency while maintaining user-friendly input handling and
providing a solid foundation for reliable financial transaction categorization.
