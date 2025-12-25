"""
Pydantic schemas for API requests and responses

Organized by resource type for better maintainability.
"""
from datetime import datetime, date
from typing import Optional, List, Dict

from pydantic import BaseModel, Field


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


class TransactionResponse(BaseModel):
    """Schema for transaction responses"""
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

    class Config:
        from_attributes = True


class TransactionFrontend(BaseModel):
    """Schema for frontend transaction API"""
    id: Optional[int] = None
    transaction_date: str
    description: str
    amount: float
    category: str
    bank_source: Optional[str] = None


class TransactionSummary(BaseModel):
    """Schema for transaction summary statistics"""
    total_transactions: int
    total_amount: float
    average_amount: float
    min_amount: float
    max_amount: float
    date_range: dict


# ===== Additional Transaction Schemas for CLI parity =====
class ExportCSVRequest(BaseModel):
    output: str = Field(..., description="Output file path on server")
    bank_account: str = Field(..., description="Bank account name or ID")
    from_date: Optional[str] = Field(None, description="Start date YYYY-MM-DD")
    to_date: Optional[str] = Field(None, description="End date YYYY-MM-DD")
    category_id: Optional[int] = Field(None, description="Filter by category ID")


class ExportCSVResponse(BaseModel):
    success: bool
    count: int
    file_path: str
    date_range: Optional[Dict[str, str]] = None
    message: Optional[str] = None


# ==================== Category Schemas ====================

class CategoryBase(BaseModel):
    """Base category schema"""
    general: str = Field(..., description="General name")
    detail: str = Field(..., description="Detail name")
    description: Optional[str] = Field(None, description="Category description")
    color: Optional[str] = Field(None, description="Hex color code")


class CategoryResponse(BaseModel):
    """Schema for category responses"""
    id: int
    general: str
    detail: str
    description: Optional[str] = None
    color: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ==================== Recipient Schemas ====================

class RecipientBase(BaseModel):
    """Base recipient schema"""
    name: str = Field(..., description="Recipient name")
    account_number: Optional[str] = Field(None, description="Recipient account number")


class RecipientCreate(RecipientBase):
    """Schema for creating a recipient"""
    pass


class RecipientResponse(BaseModel):
    """Schema for recipient responses"""
    id: int
    name: str
    account_number: Optional[str] = None
    default_category_id: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Additional Category/Recipient management =====
class RecipientUpdate(BaseModel):
    name: Optional[str] = Field(None, description="Recipient name")
    account_number: Optional[str] = Field(None, description="Account number (empty string to clear)")
    category_id: Optional[int] = Field(None, description="Default category ID (0 to clear)")
    notes: Optional[str] = Field(None, description="Notes (empty string to clear)")


class AssignCategoryRequest(BaseModel):
    category_general: str = Field(..., description="Category general name")
    category_detail: str = Field(..., description="Category detail name")
    recipient_ids: List[int] = Field(None, description="List of recipient IDs")


class ApplyCategoriesRequest(BaseModel):
    recipient_id: Optional[int] = Field(None, description="Recipient ID to apply categories for")
    overwrite: bool = Field(False, description="Overwrite existing categories on transactions")


class UncategorizedResponse(BaseModel):
    recipients: Optional[List[Dict]] = None
    transactions: Optional[List[Dict]] = None


class DBResetRequest(BaseModel):
    force: bool = Field(..., description="Must be true to confirm database reset")


# ==================== Import Schemas ====================

class CSVImportRequest(BaseModel):
    """Schema for CSV import request"""
    csv_content: str = Field(..., description="CSV file content as string")
    bank_source: Optional[str] = Field(None, description="Bank or source name")


class CSVImportResponse(BaseModel):
    """Schema for CSV import response"""
    imported: int = Field(..., description="Number of transactions imported")
    message: str = Field(..., description="Import result message")


class ImportResult(BaseModel):
    """Schema for detailed import result"""
    batch_id: str
    total_processed: int
    imported: int
    duplicates: int
    errors: int
    status: str
    error_message: Optional[str] = None


class CustomImportConfig(BaseModel):
    """Schema for custom CSV import configuration"""
    bank_name: str = Field(..., description="Custom bank name")
    date_format: str = Field(..., description="Date format string")
    date_column: str = Field(..., description="Date column name")
    recipient_column: str = Field(..., description="Recipient column name")
    amount_column: str = Field(..., description="Amount column name")
    memo_column: Optional[str] = Field(None, description="Memo column name")
    separator: str = Field(",", description="CSV separator")
    encoding: str = Field("utf-8", description="File encoding")
    skip_rows: int = Field(0, description="Rows to skip")


# ==================== Statistics Schemas ====================

class CategoryStats(BaseModel):
    """Category statistics"""
    name: str
    count: int


class StatisticsResponse(BaseModel):
    """Schema for statistics response"""
    total_transactions: int
    total_amount: float
    categories: List[CategoryStats]


class BankListResponse(BaseModel):
    """Schema for bank list response"""
    banks: List[str]
