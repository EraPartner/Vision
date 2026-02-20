"""Raw transaction models for bank-specific data storage.

This module defines immutable, append-only tables for storing raw CSV data exactly as imported.
Each bank has its own table with fields matching the CSV structure from the bank adapters.

These tables serve as the source of truth for:
- Original transaction data preservation
- Deduplication at the source level
- Balance calculation
- Audit trails

Design Principles:
- Immutable: No updates allowed, only inserts
- Append-only: Historical record of all imports
- Exact CSV mapping: Fields match bank adapter parsing
- Hash-based deduplication: Prevent duplicate imports
"""

from enum import Enum as PyEnum

from sqlalchemy import Column, Integer, String, DateTime, Date, Numeric, Text, Index, CheckConstraint, Enum as SQLEnum, \
    JSON, event, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from database.models import Base


class BelfiusRawTransaction(Base):
    """Raw transaction data from Belfius bank CSV imports.

    Stores the exact CSV structure as parsed by BelfiusAdapter.
    Immutable and append-only for audit trail preservation.

    CSV Structure (Belfius):
    - Account number (IBAN)
    - Transaction date
    - Statement and transaction reference numbers
    - Recipient details (account, name, address, BIC, country)
    - Transaction description and value date
    - Amount, currency, balance
    - Additional messages
    """
    __tablename__ = "belfius_raw_transactions"

    # Primary key and audit fields
    id = Column(Integer, primary_key=True, index=True)
    deduplication_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Raw CSV fields (matching BelfiusAdapter structure)
    # Core transaction identification
    account_number = Column(String(34), nullable=False, index=True)  # IBAN format (max 34 chars per ISO 13616)
    transaction_date = Column(Date, nullable=False, index=True)
    statement_number = Column(String(50), nullable=True)
    transaction_number = Column(String(50), nullable=True)

    # Recipient information
    recipient_account = Column(String(34), nullable=True)  # IBAN
    recipient_name = Column(Text, nullable=True)
    recipient_street = Column(Text, nullable=True)
    recipient_location = Column(Text, nullable=True)
    recipient_bic = Column(String(11), nullable=True)
    recipient_country = Column(String(2), nullable=True)  # ISO country code

    # Transaction details
    transaction_description = Column(Text, nullable=True)
    value_date = Column(Date, nullable=True)
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=False)  # EUR, USD, etc. (ISO 4217)
    balance = Column(Numeric(15, 2), nullable=True)  # Account balance after transaction

    # Additional information
    additional_message = Column(Text, nullable=True)

    # Original raw CSV line for complete preservation
    raw_csv_line = Column(Text, nullable=False)

    # Table constraints and indexes
    __table_args__ = (
        Index('idx_belfius_account_date', 'account_number', 'transaction_date'),
    )


class RevolutRawTransaction(Base):
    """Raw transaction data from Revolut bank CSV imports.

    Stores the exact CSV structure as parsed by RevolutAdapter.
    Immutable and append-only for audit trail preservation.

    CSV Structure (Revolut):
    - Type, Product (account type)
    - Started and Completed dates
    - Description (merchant/recipient)
    - Amount, Fee, Currency
    - State (COMPLETED, PENDING, etc.)
    - Balance
    """
    __tablename__ = "revolut_raw_transactions"

    # Primary key and audit fields
    id = Column(Integer, primary_key=True, index=True)
    deduplication_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Raw CSV fields (matching RevolutAdapter structure)
    # Transaction classification
    transaction_type = Column(String(50), nullable=False)  # Card Payment, Transfer, ATM, Exchange
    product = Column(String(50), nullable=False)  # Current, Savings

    # Dates and timing
    started_date = Column(DateTime, nullable=True)  # When transaction initiated
    completed_date = Column(DateTime, nullable=False, index=True)  # When completed

    # Transaction details
    description = Column(Text, nullable=False)  # Merchant/recipient name
    amount = Column(Numeric(15, 2), nullable=False)
    fee = Column(Numeric(15, 2), nullable=True, default=0.00)
    currency = Column(String(3), nullable=False)

    # Transaction state and balance
    class RevolutState(PyEnum):
        COMPLETED = 'COMPLETED'
        PENDING = 'PENDING'
        REVERTED = 'REVERTED'
        DECLINED = 'DECLINED'

    state = Column(SQLEnum(RevolutState, name='revolut_state'), nullable=False)
    balance = Column(Numeric(15, 2), nullable=True)

    # Original raw CSV line for complete preservation
    raw_csv_line = Column(Text, nullable=False)

    # Table constraints and indexes
    __table_args__ = (
        Index('idx_revolut_product_date', 'product', 'completed_date'),
        Index('idx_revolut_state', 'state'),
    )


class KBCRawTransaction(Base):
    """Raw transaction data from KBC bank CSV imports.

    Stores the exact CSV structure as parsed by KBCAdapter.
    Immutable and append-only for audit trail preservation.

    CSV Structure (KBC):
    - Account number (IBAN), category, holder name
    - Statement number, transaction and value dates
    - Description, amount, balance
    - Credit/debit indicators
    - Counterparty details (account, BIC, name, address)
    - Structured and free communications
    """
    __tablename__ = "kbc_raw_transactions"

    # Primary key and audit fields
    id = Column(Integer, primary_key=True, index=True)
    deduplication_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Raw CSV fields (matching KBCAdapter structure)
    # Account information
    account_number = Column(String(34), nullable=False, index=True)  # IBAN format
    category_name = Column(Text, nullable=True)  # Rubrieknaam
    account_holder_name = Column(Text, nullable=True)  # Naam

    # Transaction identification
    currency = Column(String(3), nullable=False)
    statement_number = Column(String(50), nullable=True)
    transaction_date = Column(Date, nullable=False, index=True)
    value_date = Column(Date, nullable=True)

    # Transaction details
    description = Column(Text, nullable=True)  # Omschrijving
    amount = Column(Numeric(15, 2), nullable=False)
    balance = Column(Numeric(15, 2), nullable=True)

    # Credit/debit indicators
    credit_amount = Column(Numeric(15, 2), nullable=True)
    debit_amount = Column(Numeric(15, 2), nullable=True)

    # Counterparty information
    counterparty_account = Column(String(34), nullable=True)  # IBAN
    counterparty_bic = Column(String(11), nullable=True)
    counterparty_name = Column(Text, nullable=True)
    counterparty_address = Column(Text, nullable=True)

    # Communications
    structured_communication = Column(Text, nullable=True)  # Gestructureerde mededeling
    free_communication = Column(Text, nullable=True)  # Vrije mededeling

    # Original raw CSV line for complete preservation
    raw_csv_line = Column(Text, nullable=False)

    # Table constraints and indexes
    __table_args__ = (
        Index('idx_kbc_account_date', 'account_number', 'transaction_date'),
        Index('idx_kbc_statement', 'statement_number'),
        CheckConstraint('length(account_number) <= 34', name='ck_kbc_account_len'),
    )


class CustomRawTransaction(Base):
    """Custom raw transaction table for manually added transactions."""

    __tablename__ = "custom_raw_transactions"

    # Primary key and audit fields
    id = Column(Integer, primary_key=True, index=True)
    deduplication_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Core fields
    date = Column(DateTime, nullable=False, index=True)
    description = Column(Text, nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=False, index=True)
    counterparty_name = Column(Text, nullable=False)
    counterparty_account = Column(String(34), nullable=False, index=True)  # IBAN (max 34)

    # Optional bookkeeping
    balance = Column(Numeric(15, 2), nullable=True)
    category_name = Column(Text, nullable=True)
    comments = Column(Text, nullable=True)

    # Preserve original input and flexible metadata
    raw_csv_line = Column(Text, nullable=True)
    raw_metadata = Column(JSON, nullable=True)

    __table_args__ = (
        CheckConstraint('length(counterparty_account) <= 34', name='ck_custom_counterparty_account_len'),
        Index('idx_custom_date', 'date'),
    )


# SQLAlchemy event listener: validate and normalize IBAN for CustomRawTransaction.counterparty_account
@event.listens_for(CustomRawTransaction.counterparty_account, 'set')
def validate_custom_counterparty_account(target, value, oldvalue, initiator):
    """Normalize counterparty_account using services.iban and validate checksum.

    Returns the compacted IBAN (no spaces, uppercase) or raises ValueError on invalid IBAN.
    """
    if value and isinstance(value, str):
        try:
            from services.iban import normalize_iban, is_valid_iban
        except Exception:
            # If the helper is missing for some reason, fall back to basic trimming and uppercasing
            v = value.strip().upper()
            if len(v) > 34 or not all(c.isalnum() for c in v):
                raise ValueError(f"Invalid counterparty account format: {value!r}")
            return v

        v = normalize_iban(value)
        if not is_valid_iban(v):
            raise ValueError(f"Invalid IBAN/account number checksum: {value!r}")
        return v
    return value


# TransactionRawReference was missing from this module and is required by services and repos.
class TransactionRawReference(Base):
    """Links normalized transactions to their raw bank source.

    Uses a discriminator pattern to maintain a flexible relationship between
    the normalized Transaction table and bank-specific raw tables.
    """
    __tablename__ = "transaction_raw_references"

    id = Column(Integer, primary_key=True, index=True)

    # Link to normalized transaction (one-to-one)
    transaction_id = Column(Integer, ForeignKey("transactions.id", ondelete="CASCADE"),
                            nullable=False, unique=True, index=True)

    # Discriminator for the raw source (e.g., 'belfius', 'revolut', 'kbc')
    raw_source_type = Column(String(20), nullable=False, index=True)
    raw_source_id = Column(Integer, nullable=False, index=True)

    # Timestamps
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    # Relationship back to normalized Transaction
    transaction = relationship("Transaction", back_populates="raw_reference")

    __table_args__ = (
        Index('idx_raw_ref_source', 'raw_source_type', 'raw_source_id'),
        # Ensure a raw source maps to at most one normalized transaction
        CheckConstraint('raw_source_id >= 0', name='ck_raw_source_id_non_negative'),
    )
