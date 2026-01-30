"""
Pydantic schemas for API requests and responses.

Organized by logical grouping for better maintainability:
1. Foundation schemas (Link, MethodInfo)
2. Common/shared responses (MessageResponse)
3. API discovery responses (OPTIONS endpoints)
4. Admin schemas
5. Category schemas
6. Recipient schemas
7. Transaction schemas
8. Statistics schemas
9. Import schemas
10. Utility schemas
"""
from datetime import datetime, date
from typing import Optional, List, Dict

from pydantic import BaseModel, Field, field_validator


# ==================== Foundation Schemas ====================

class Link(BaseModel):
    """Represents a hypermedia link for HATEOAS (Level 3 REST API)"""
    rel: str = Field(..., description="Relation type (e.g., 'self', 'parent', 'init', 'reset')")
    href: str = Field(..., description="URL to follow")
    method: str = Field(default="GET", description="HTTP method to use")
    title: Optional[str] = Field(None, description="Human-readable description of the action")


class MethodInfo(BaseModel):
    """Information about an available HTTP method"""
    method: str = Field(..., description="HTTP method (GET, POST, PATCH, DELETE, etc.)")
    description: str = Field(..., description="Description of what the method does")


# ==================== Common/Shared Response Schemas ====================

class MessageResponse(BaseModel):
    """Message response with HATEOAS links for Level 3 REST API"""
    message: str = Field(..., description="Response message")
    details: Optional[dict[str, str]] = Field(None, description="Additional details")
    links: Optional[List[Link]] = Field(None, description="Available actions (HATEOAS links)")


# ==================== API Discovery Schemas (OPTIONS endpoints) ====================

class OptionsResponse(BaseModel):
    """Standard response for OPTIONS endpoint discovery"""
    methods: List[MethodInfo] = Field(..., description="Available HTTP methods")
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


class RootOptionsResponse(BaseModel):
    """Response for root API endpoint OPTIONS discovery"""
    methods: List[MethodInfo] = Field(..., description="Available HTTP methods")
    description: str = Field(..., description="API root description")
    links: List[Link] = Field(..., description="Available API resources and actions")


class APIRootResponse(BaseModel):
    """API root discovery endpoint response with HATEOAS links"""
    version: str = Field(..., description="API version")
    title: str = Field(..., description="API title")
    description: str = Field(..., description="API description")
    links: List[Link] = Field(..., description="Available resource endpoints (HATEOAS links)")


# ==================== Admin Schemas ====================

class AdminStatusResponse(BaseModel):
    """Current database administration status with available actions (Level 3 REST API)"""
    is_initialised: bool = Field(..., description="Whether the database is initialised")
    table_count: int = Field(..., description="Number of tables in database")
    timestamp: str = Field(..., description="Response timestamp (ISO 8601)")
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


class DBResetRequest(BaseModel):
    """Request schema for database reset operation"""
    force: bool = Field(..., description="Must be true to confirm database reset")


# ==================== Category Schemas ====================

class CategoryBase(BaseModel):
    """Base category schema for requests"""
    general: str = Field(..., description="General name")
    detail: str = Field(..., description="Detail name")
    description: Optional[str] = Field(None, description="Category description")
    color: Optional[str] = Field(None, description="Hex color code")


class CategoryUpdate(BaseModel):
    """Schema for updating a category"""
    general: Optional[str] = Field(None, description="General name")
    detail: Optional[str] = Field(None, description="Detail name")
    description: Optional[str] = Field(None, description="Category description")
    color: Optional[str] = Field(None, description="Hex colour code")


class CategoryResponse(BaseModel):
    """Category response with HATEOAS links for Level 3 REST API"""
    id: int = Field(..., description="Category ID")
    general: str = Field(..., description="General name")
    detail: str = Field(..., description="Detail name")
    description: Optional[str] = Field(None, description="Category description")
    color: Optional[str] = Field(None, description="Hex color code")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Last update timestamp")
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")

    class Config:
        from_attributes = True


class CategoriesListResponse(BaseModel):
    """Paginated categories list response with HATEOAS links for Level 3 REST API"""
    items: List[CategoryResponse] = Field(..., description="Category items")
    total: int = Field(..., description="Total count of categories")
    limit: int = Field(..., description="Limit used for pagination")
    offset: int = Field(..., description="Offset used for pagination")
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


class AssignCategoryRequest(BaseModel):
    """Request schema for assigning a category to recipients"""
    category_general: str = Field(..., description="Category general name")
    category_detail: str = Field(..., description="Category detail name")
    recipient_ids: list[int] | int = Field(..., description="Recipient ID or list of recipient IDs")

    @field_validator("recipient_ids")
    @classmethod
    def normalise_recipient_ids(cls, value: list[int] | int) -> list[int]:
        if isinstance(value, int):
            return [value]
        if not value:
            raise ValueError("recipient_ids must contain at least one ID")
        return value


class AssignCategoryResponse(BaseModel):
    """Response schema for category assignment operation"""
    updated_recipients: int = Field(..., description="Number of recipients updated")
    links: List[Link] = Field(..., description="Available next actions (HATEOAS links)")


class ApplyCategoriesRequest(BaseModel):
    """Request schema for applying categories to transactions"""
    recipient_id: Optional[int] = Field(None, description="Recipient ID to apply categories for")
    overwrite: bool = Field(False, description="Overwrite existing categories on transactions")


# ==================== Recipient Schemas ====================

class RecipientBase(BaseModel):
    """Base recipient schema for requests"""
    name: str = Field(..., description="Recipient name")
    account_number: Optional[str] = Field(None, description="Recipient account number")


class RecipientCreate(RecipientBase):
    """Schema for creating a recipient"""
    pass


class RecipientUpdate(BaseModel):
    """Schema for updating a recipient"""
    name: Optional[str] = Field(None, description="Recipient name")
    account_number: Optional[str] = Field(None, description="Account number (empty string to clear)")
    category_id: Optional[int] = Field(None, description="Default category ID (0 to clear)")
    notes: Optional[str] = Field(None, description="Notes (empty string to clear)")


class RecipientResponse(BaseModel):
    """Recipient response"""
    id: int
    name: str
    account_number: Optional[str] = None
    default_category_id: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RecipientResponseWithLinks(BaseModel):
    """Recipient response with HATEOAS links for Level 3 REST API"""
    id: int
    name: str
    account_number: Optional[str] = None
    default_category_id: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")

    class Config:
        from_attributes = True


class RecipientsListResponse(BaseModel):
    """Paginated recipients list response with HATEOAS links for Level 3 REST API"""
    items: List[RecipientResponseWithLinks] = Field(..., description="Recipient items")
    total: int = Field(..., description="Total count of recipients")
    limit: int = Field(..., description="Limit used for pagination")
    offset: int = Field(..., description="Offset used for pagination")
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


# ==================== Transaction Schemas ====================

class TransactionBase(BaseModel):
    """Base transaction schema with common fields"""
    transaction_date: str = Field(..., description="Transaction date (YYYY-MM-DD format)")
    description: str = Field(..., description="Transaction description/recipient")
    amount: float = Field(..., description="Transaction amount")
    category: str = Field(..., description="Category name")
    bank_source: Optional[str] = Field(None, description="Bank or account source")


class TransactionCreate(TransactionBase):
    """Schema for creating a new transaction"""
    pass


class TransactionUpdate(BaseModel):
    """Schema for updating an existing transaction"""
    transaction_date: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    category: Optional[str] = None
    bank_source: Optional[str] = None


class TransactionFrontend(BaseModel):
    """Schema for frontend transaction API"""
    id: Optional[int] = None
    transaction_date: str
    description: str
    amount: float
    category: str
    bank_source: Optional[str] = None


class TransactionResponseWithLinks(BaseModel):
    """Transaction response with HATEOAS links for Level 3 REST API"""
    id: int
    date: date
    bank_account: str
    recipient: str
    memo: Optional[str] = None
    amount: float
    currency: Optional[str] = None
    balance: Optional[float] = None
    category_id: Optional[int] = None
    created_at: datetime
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")

    class Config:
        from_attributes = True


class TransactionsListResponse(BaseModel):
    """Paginated transactions list response with HATEOAS links for Level 3 REST API"""
    items: List[TransactionResponseWithLinks] = Field(..., description="Transaction items")
    total: int = Field(..., description="Total count of transactions")
    limit: int = Field(..., description="Limit used for pagination")
    offset: int = Field(..., description="Offset used for pagination")
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


class ExportCSVRequest(BaseModel):
    """Request schema for CSV export"""
    output: str = Field(..., description="Output file path on server")
    bank_account: str = Field(..., description="Bank account name or ID")
    from_date: Optional[str] = Field(None, description="Start date YYYY-MM-DD")
    to_date: Optional[str] = Field(None, description="End date YYYY-MM-DD")
    category_id: Optional[int] = Field(None, description="Filter by category ID")


class ExportCSVResponse(BaseModel):
    """Response schema for CSV export"""
    success: bool
    count: int
    file_path: str
    date_range: Optional[Dict[str, str]] = None
    message: Optional[str] = None


class UncategorizedResponse(BaseModel):
    """Response for retrieving uncategorized recipients and transactions"""
    recipients: Optional[List[Dict]] = None
    transactions: Optional[List[Dict]] = None


# ==================== Statistics Schemas ====================

class CategoryStats(BaseModel):
    """Category statistics"""
    name: str
    count: int


class StatisticsResponse(BaseModel):
    """Response schema for statistics"""
    total_transactions: int
    total_amount: float
    categories: List[CategoryStats]


class StatisticsResponseWithLinks(BaseModel):
    """Statistics response with HATEOAS links for Level 3 REST API"""
    total_transactions: int
    total_amount: float
    categories: List[CategoryStats]
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


class BankListResponse(BaseModel):
    """Response schema for bank list"""
    banks: List[str]


# ==================== Import Schemas ====================

class CSVImportRequest(BaseModel):
    """Request schema for CSV import"""
    csv_content: str = Field(..., description="CSV file content as string")
    bank_source: Optional[str] = Field(None, description="Bank or source name")


class ImportResult(BaseModel):
    """Response schema for import result"""
    batch_id: str
    total_processed: int
    imported: int
    duplicates: int
    errors: int
    status: str
    error_message: Optional[str] = None


class ImportResultWithLinks(BaseModel):
    """Import result response with HATEOAS links for Level 3 REST API"""
    batch_id: str
    total_processed: int
    imported: int
    duplicates: int
    errors: int
    status: str
    error_message: Optional[str] = None
    links: List[Link] = Field(..., description="Available actions (HATEOAS links)")


class CustomImportConfig(BaseModel):
    """Request schema for custom CSV import configuration"""
    bank_name: str = Field(..., description="Custom bank name")
    date_format: str = Field(..., description="Date format string")
    date_column: str = Field(..., description="Date column name")
    recipient_column: str = Field(..., description="Recipient column name")
    amount_column: str = Field(..., description="Amount column name")
    memo_column: Optional[str] = Field(None, description="Memo column name")
    separator: str = Field(",", description="CSV separator")
    encoding: str = Field("utf-8", description="File encoding")
    skip_rows: int = Field(0, description="Rows to skip")
