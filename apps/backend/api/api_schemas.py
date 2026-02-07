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
8. Info schemas
9. Import schemas
10. Utility schemas
"""
from datetime import datetime, date
from typing import Optional, List, Dict

from pydantic import BaseModel, Field, field_validator, HttpUrl


# ==================== Foundation Schemas ====================

class Link(BaseModel):
    """Represents a hypermedia link for HATEOAS (Level 3 REST API)"""
    rel: str = Field(description="Relation type", examples=["self", "parent", "init", "reset", "next", "prev"])
    href: HttpUrl = Field(description="URL to follow")
    method: str = Field(default="GET", description="HTTP method to use", min_length=3,
                        examples=["GET", "POST", "OPTIONS", "DELETE", "PATCH"])
    title: Optional[str] = Field(None, description="Human-readable description of the action")


class MethodInfo(BaseModel):
    """Information about an available HTTP method"""
    method: str = Field(default="GET", description="HTTP method to use", min_length=3,
                        examples=["GET", "POST", "OPTIONS", "DELETE", "PATCH"])
    description: str = Field(description="Description of what the method does")


# ==================== Common/Shared Response Schemas ====================

class MessageResponse(BaseModel):
    """Message response with HATEOAS links for Level 3 REST API"""
    message: str = Field(description="Response message")
    details: Optional[dict[str, str]] = Field(None, description="Additional details")
    links: Optional[List[Link]] = Field(None, description="Available actions (HATEOAS links)")


# ==================== API Discovery Schemas (OPTIONS endpoints) ====================

class OptionsResponse(BaseModel):
    """Standard response for OPTIONS endpoint discovery"""
    methods: List[MethodInfo] = Field(description="Available HTTP methods")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


class RootOptionsResponse(OptionsResponse):
    """Response for root API endpoint OPTIONS discovery"""
    description: str = Field(description="API root description")


class APIRootResponse(BaseModel):
    """API root discovery endpoint response with HATEOAS links"""
    version: str = Field(description="API version")
    title: str = Field(description="API title")
    description: str = Field(description="API description")
    links: List[Link] = Field(description="Available resource endpoints (HATEOAS links)")


# ==================== Admin Schemas ====================

class AdminStatusResponse(BaseModel):
    """Current database administration status with available actions (Level 3 REST API)"""
    is_initialised: bool = Field(description="Whether the database is initialised")
    table_count: int = Field(description="Number of tables in database")
    timestamp: datetime = Field(description="Response timestamp (ISO 8601)")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


class DBResetRequest(BaseModel):
    """Request schema for database reset operation"""
    force: bool = Field(description="Must be true to confirm database reset")


# ==================== Category Schemas ====================

class CategoryBase(BaseModel):
    """Base category schema for requests"""
    general: str = Field(description="General name", min_length=1)
    detail: str = Field(description="Detail name", min_length=1)
    description: Optional[str] = Field(None, description="Category description")

    @field_validator("general", "detail", mode="before")
    @classmethod
    def normalise(cls, value: str) -> str:
        """Normalise text fields to uppercase using TextNormalizationService."""
        from services.text_normalization_service import TextNormalizationService
        return TextNormalizationService.normalize_category_name(value)


class CategoryUpdate(BaseModel):
    """Schema for updating a category"""
    general: Optional[str] = Field(None, description="General name", min_length=1)
    detail: Optional[str] = Field(None, description="Detail name", min_length=1)
    description: Optional[str] = Field(None, description="Category description")

    @field_validator("general", "detail", mode="before")
    @classmethod
    def normalise(cls, value: str) -> str:
        """Normalise text fields to uppercase using TextNormalizationService."""
        from services.text_normalization_service import TextNormalizationService
        return TextNormalizationService.normalize_category_name(value)


class CategoryResponse(CategoryBase):
    """Category response with HATEOAS links for Level 3 REST API"""
    id: int = Field(description="Category ID", ge=1)
    created_at: datetime = Field(description="Creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Last update timestamp")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")

    model_config = {"from_attributes": True}


class CategoriesListResponse(BaseModel):
    """Paginated categories list response with HATEOAS links for Level 3 REST API"""
    items: List[CategoryResponse] = Field(description="Category items")
    total: int = Field(description="Total count of categories")
    limit: int = Field(description="Limit used for pagination", ge=1)
    offset: int = Field(description="Offset used for pagination", ge=0)
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


class AssignCategoryRequest(BaseModel):
    """Request schema for assigning a category to recipients"""
    category_general: str = Field(description="Category general name", min_length=1)
    category_detail: str = Field(description="Category detail name", min_length=1)
    recipient_ids: List[int] | int = Field(description="Recipient ID or list of recipient IDs")

    @field_validator("recipient_ids")
    @classmethod
    def normalise_recipient_ids(cls, value: List[int] | int) -> List[int]:
        if isinstance(value, int):
            return [value]
        return value

    @field_validator("category_general", "category_detail", mode="before")
    @classmethod
    def normalise(cls, value: str) -> str:
        """Normalise category fields using TextNormalizationService."""
        from services.text_normalization_service import TextNormalizationService
        return TextNormalizationService.normalize_category_name(value)


class AssignCategoryResponse(BaseModel):
    """Response schema for category assignment operation"""
    updated_recipients: int = Field(description="Number of recipients updated")
    links: List[Link] = Field(description="Available next actions (HATEOAS links)")


class ApplyCategoriesRequest(BaseModel):
    """Request schema for applying categories to transactions"""
    recipient_id: Optional[int] = Field(None, description="Recipient ID to apply categories for")
    overwrite: bool = Field(False, description="Overwrite existing categories on transactions")


# ==================== Recipient Schemas ====================

class RecipientBase(BaseModel):
    """Base recipient schema for requests"""
    name: str = Field(description="Recipient name", min_length=1)
    account_number: Optional[str] = Field(None, description="Recipient account number")
    default_category_id: Optional[int] = Field(None, description="Default category ID", ge=1)
    notes: Optional[str] = Field(None, description="Notes")
    address: Optional[str] = Field(None, description="Address")

    @field_validator("name", "address", mode="before")
    @classmethod
    def normalise_name(cls, value: str) -> str:
        """Normalise recipient name and address to uppercase using TextNormalizationService."""
        if value is None:
            return value
        from services.text_normalization_service import TextNormalizationService
        return TextNormalizationService.normalize_recipient_name(value)


class RecipientUpdate(BaseModel):
    """Schema for updating a recipient"""
    name: Optional[str] = Field(None, description="Recipient name", min_length=1)
    account_number: Optional[str] = Field(None, description="Account number")
    category_id: Optional[int] = Field(None, description="Default category ID", ge=1)
    notes: Optional[str] = Field(None, description="Notes")
    address: Optional[str] = Field(None, description="Address")
    is_active: Optional[bool] = Field(None, description="Whether recipient is active")

    @field_validator("name", "address", mode="before")
    @classmethod
    def normalise_name(cls, value: str) -> str:
        """Normalise recipient name and address to uppercase using TextNormalizationService."""
        if value is None:
            return value
        from services.text_normalization_service import TextNormalizationService
        return TextNormalizationService.normalize_recipient_name(value)


class RecipientResponse(BaseModel):
    """Recipient response with HATEOAS links for Level 3 REST API"""
    id: int = Field(description="Recipient ID", ge=1)
    name: str = Field(description="Recipient name")
    account_number: Optional[str] = Field(None, description="Account number")
    default_category_id: Optional[int] = Field(None, description="Default category ID", ge=1)
    notes: Optional[str] = Field(None, description="Notes")
    address: Optional[str] = Field(None, description="Address")
    is_active: bool = Field(True, description="Whether recipient is active")
    created_at: datetime = Field(description="Creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Last update timestamp")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")

    model_config = {"from_attributes": True}


class RecipientsListResponse(BaseModel):
    """Paginated recipients list response with HATEOAS links for Level 3 REST API"""
    items: List[RecipientResponse] = Field(description="Recipient items")
    total: int = Field(description="Total count of recipients")
    limit: int = Field(description="Limit used for pagination", ge=1)
    offset: int = Field(description="Offset used for pagination", ge=0)
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


# ==================== Transaction Schemas ====================

class TransactionBase(BaseModel):
    """Base transaction schema for requests"""
    transaction_date: date = Field(description="Transaction date", alias="date")
    bank_account: str = Field(description="Bank account name", min_length=1)
    recipient_id: int = Field(description="Recipient ID", ge=1)
    memo: Optional[str] = Field(None, description="Transaction memo/note")
    amount: float = Field(description="Transaction amount")
    currency: Optional[str] = Field(None, description="Currency code (EUR, USD, etc.)", max_length=3)
    balance: Optional[float] = Field(None, description="Account balance after transaction")
    category_id: Optional[int] = Field(None, description="Category ID", ge=1)
    comment: Optional[str] = Field(None, description="Additional comment")

    model_config = {"populate_by_name": True}


class TransactionCreate(TransactionBase):
    """Schema for creating a new transaction"""
    pass


class TransactionUpdate(BaseModel):
    """Schema for updating an existing transaction"""
    transaction_date: Optional[date] = Field(None, description="Transaction date", alias="date")
    bank_account: Optional[str] = Field(None, description="Bank account name", min_length=1)
    recipient_id: Optional[int] = Field(None, description="Recipient ID", ge=1)
    memo: Optional[str] = Field(None, description="Transaction memo/note")
    amount: Optional[float] = Field(None, description="Transaction amount")
    currency: Optional[str] = Field(None, description="Currency code", max_length=3)
    balance: Optional[float] = Field(None, description="Account balance after transaction")
    category_id: Optional[int] = Field(None, description="Category ID", ge=1)
    comment: Optional[str] = Field(None, description="Additional comment")

    model_config = {"populate_by_name": True}


class TransactionResponse(BaseModel):
    """Transaction response with HATEOAS links for Level 3 REST API"""
    id: int = Field(description="Transaction ID", ge=1)
    transaction_date: date = Field(description="Transaction date", alias="date")
    bank_account: str = Field(description="Bank account name")
    recipient_id: Optional[int] = Field(None, description="Recipient ID", ge=1)
    memo: Optional[str] = Field(None, description="Transaction memo/note")
    amount: float = Field(description="Transaction amount")
    currency: Optional[str] = Field(None, description="Currency code (EUR, USD, etc.)")
    balance: Optional[float] = Field(None, description="Account balance after transaction")
    category_id: Optional[int] = Field(None, description="Category ID", ge=1)
    comment: Optional[str] = Field(None, description="Additional comment")
    created_at: datetime = Field(description="Creation timestamp")
    updated_at: Optional[datetime] = Field(None, description="Last update timestamp")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")

    model_config = {"from_attributes": True, "populate_by_name": True}


class TransactionsListResponse(BaseModel):
    """Paginated transactions list response with HATEOAS links for Level 3 REST API"""
    items: List[TransactionResponse] = Field(description="Transaction items")
    total: int = Field(description="Total count of transactions")
    limit: int = Field(description="Limit used for pagination", ge=1)
    offset: int = Field(description="Offset used for pagination", ge=0)
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


# Legacy schemas for backward compatibility
class TransactionFrontend(BaseModel):
    """Legacy schema for frontend transaction API (deprecated)"""
    id: Optional[int] = None
    transaction_date: str
    description: str
    amount: float
    category: str
    bank_source: Optional[str] = None


class ExportCSVRequest(BaseModel):
    """Request schema for CSV export"""
    output: str = Field(description="Output file path on server")
    bank_account: str = Field(description="Bank account name or ID")
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
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


class BankListResponse(BaseModel):
    """Response schema for bank list"""
    banks: List[str]


# ==================== Import Schemas ====================

class CSVImportRequest(BaseModel):
    """Request schema for CSV import operation.

    Note: This schema is currently not in use as the import endpoint accepts file uploads.
    Kept for potential future JSON-based import API.
    """
    csv_content: str = Field(description="CSV file content as string")
    bank_source: Optional[str] = Field(None, description="Bank or source name")


class ImportResult(BaseModel):
    """Basic import result response without HATEOAS links.

    Used as the response model for import endpoints when HATEOAS links
    are not required or in internal service-to-service communication.
    """
    batch_id: str = Field(description="Unique identifier for the import batch")
    total_processed: int = Field(description="Total number of transactions processed from CSV", ge=0)
    imported: int = Field(description="Number of new transactions successfully imported", ge=0)
    duplicates: int = Field(description="Number of duplicate transactions skipped", ge=0)
    errors: int = Field(description="Number of transactions that failed to import", ge=0)
    status: str = Field(
        description="Overall import status",
        examples=["completed", "completed_with_errors", "failed", "processing"]
    )
    error_message: Optional[str] = Field(None, description="Detailed error message if status is 'failed'")


class ImportResultWithLinks(BaseModel):
    """Import result response with HATEOAS links for Level 3 REST API.

    Enhanced version of ImportResult that includes hypermedia links for
    discovering related actions such as viewing import history, viewing
    imported transactions, or initiating another import.
    """
    batch_id: str = Field(description="Unique identifier for the import batch")
    total_processed: int = Field(description="Total number of transactions processed from CSV", ge=0)
    imported: int = Field(description="Number of new transactions successfully imported", ge=0)
    duplicates: int = Field(description="Number of duplicate transactions skipped", ge=0)
    errors: int = Field(description="Number of transactions that failed to import", ge=0)
    status: str = Field(
        description="Overall import status",
        examples=["completed", "completed_with_errors", "failed", "processing"]
    )
    error_message: Optional[str] = Field(None, description="Detailed error message if status is 'failed'")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


class ImportBatchResponse(BaseModel):
    """Response schema for a single import batch with HATEOAS links.

    Represents a complete import batch record including all metadata,
    statistics, and available actions through HATEOAS links.
    """
    id: int = Field(description="Import batch ID", ge=1)
    filename: str = Field(description="Name of the imported file")
    bank_name: str = Field(description="Bank or source name")
    status: str = Field(
        description="Import batch status",
        examples=["processing", "completed", "completed_with_errors", "failed"]
    )
    total_processed: int = Field(description="Total transactions processed", ge=0)
    imported_count: int = Field(description="Number of transactions imported", ge=0)
    duplicate_count: int = Field(description="Number of duplicates skipped", ge=0)
    error_count: int = Field(description="Number of errors encountered", ge=0)
    error_message: Optional[str] = Field(None, description="Error message if failed")
    config_used: Optional[str] = Field(None, description="JSON configuration used for import")
    created_at: datetime = Field(description="Import batch creation timestamp")
    completed_at: Optional[datetime] = Field(None, description="Import completion timestamp")
    links: List[Link] = Field(description="Available actions (HATEOAS links)")

    model_config = {"from_attributes": True}


class ImportBatchesListResponse(BaseModel):
    """Paginated import batches list response with HATEOAS links for Level 3 REST API.

    Provides a paginated list of import batch records with navigation links
    and available actions for import history management.
    """
    items: List[ImportBatchResponse] = Field(description="Import batch items")
    total: int = Field(description="Total count of import batches", ge=0)
    limit: int = Field(description="Limit used for pagination", ge=1)
    offset: int = Field(description="Offset used for pagination", ge=0)
    links: List[Link] = Field(description="Available actions (HATEOAS links)")


class CustomImportConfig(BaseModel):
    """Request schema for custom CSV import configuration.

    Allows clients to import CSV files from banks or sources that don't have
    predefined adapters by specifying the CSV structure and parsing rules.
    """
    bank_name: str = Field(description="Custom bank name", min_length=1)
    date_format: str = Field(
        description="Date format string (e.g., '%m/%d/%Y', '%d/%m/%Y')",
        examples=["%m/%d/%Y", "%d/%m/%Y", "%Y-%m-%d"]
    )
    date_column: str = Field(description="Name of the date column in CSV", min_length=1)
    recipient_column: str = Field(description="Name of the recipient/description column in CSV", min_length=1)
    amount_column: str = Field(description="Name of the amount column in CSV", min_length=1)
    memo_column: Optional[str] = Field(None, description="Name of the memo/notes column in CSV (optional)")
    separator: str = Field(",", description="CSV separator character", min_length=1)
    encoding: str = Field("utf-8", description="File encoding (e.g., 'utf-8', 'latin-1')")
    skip_rows: int = Field(0, description="Number of header rows to skip before data", ge=0)

    @field_validator("separator")
    @classmethod
    def validate_separator(cls, value: str) -> str:
        """Validate CSV separator is a single character."""
        if len(value) != 1:
            raise ValueError("Separator must be a single character")
        return value
