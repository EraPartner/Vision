"""
Custom exception classes for the Financial Transaction Manager

Provides structured error handling across the application.
"""


class FinancialTransactionError(Exception):
    """Base exception for all custom application errors"""
    pass


class ImportError(FinancialTransactionError):
    """Raised when CSV import operation fails"""
    pass


class DuplicateTransactionError(ImportError):
    """Raised when attempting to import a duplicate transaction"""
    pass


class BankAdapterError(FinancialTransactionError):
    """Raised when bank adapter encounters an error"""
    pass


class UnsupportedBankError(BankAdapterError):
    """Raised when requested bank is not supported"""
    pass


class InvalidCSVFormatError(ImportError):
    """Raised when CSV format is invalid or unsupported"""
    pass


class CategoryError(FinancialTransactionError):
    """Raised when category operation fails"""
    pass


class InvalidCategoryFormatError(CategoryError):
    """Raised when category format is invalid"""
    pass


class RecipientError(FinancialTransactionError):
    """Raised when recipient operation fails"""
    pass


class TransactionError(FinancialTransactionError):
    """Raised when transaction operation fails"""
    pass


class TransactionNotFoundError(TransactionError):
    """Raised when transaction is not found"""
    pass


class ConfigurationError(FinancialTransactionError):
    """Raised when configuration is invalid"""
    pass


class DatabaseError(FinancialTransactionError):
    """Raised when database operation fails"""
    pass
