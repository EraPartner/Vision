from typing import Optional

from sqlalchemy import Column, Integer, String, DateTime, Date, Numeric, Text, UniqueConstraint, ForeignKey, \
    Boolean, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

Base = declarative_base()


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)

    # Core transaction data
    date = Column(Date, nullable=False, index=True)  # Changed from DateTime to Date
    amount = Column(Numeric(10, 2), nullable=False)
    currency = Column(String(3), nullable=True)  # Currency code (EUR, USD, etc.)
    balance = Column(Numeric(12, 2), nullable=True)  # Account balance after transaction
    memo = Column(Text, nullable=True)
    comment = Column(Text, nullable=True)  # Additional comment field for bank-specific data
    bank_account = Column(Text, nullable=True,
                          index=True)  # Which bank/account (e.g., "Revolut", "KBC Checking Account")

    # Foreign keys
    recipient_id = Column(Integer, ForeignKey("recipients.id"), nullable=False)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    batch_id = Column(Integer, ForeignKey("import_batches.id"), nullable=True)

    # Soft deletion support
    is_active = Column(Boolean, default=True, nullable=False)

    # Import metadata
    original_raw_data = Column(Text, nullable=True)  # Store original CSV row
    bank_reference = Column(Text, nullable=True)  # Bank's transaction ID

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    recipient = relationship("Recipient", back_populates="transactions")
    category = relationship("Category", back_populates="transactions")
    import_batch = relationship("ImportBatch", back_populates="transactions")

    @property
    def category_name(self) -> Optional[str]:
        """Get the category name in 'General:Detail' format.

        Returns the full category path for the transaction's category.
        If the transaction doesn't have a direct category assigned (category_id is None),
        falls back to the recipient's default category.

        This property provides easy access to the category name for API responses,
        automatically resolving the effective category for the transaction.

        Returns:
            Optional[str]: Category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES').
                          Returns the transaction's category if set, otherwise the recipient's
                          default category. Returns None if neither is available.
        """
        # Priority 1: Transaction's direct category assignment
        if self.category:
            return self.category.full_path()

        # Priority 2: Recipient's default category (fallback)
        if self.recipient and self.recipient.default_category:
            return self.recipient.default_category.full_path()

        return None

    @property
    def recipient_name(self) -> Optional[str]:
        """Get the recipient name for this transaction.

        Returns the name of the recipient associated with this transaction.
        This property provides easy access to the recipient name for API responses
        without requiring explicit joins in queries.

        Returns:
            Optional[str]: Recipient name (in UPPERCASE), or None if no recipient is set.
        """
        if self.recipient:
            return self.recipient.name
        return None


class Category(Base):
    """
    Category model - stores information about transaction categories

    Automatically converts general and detail fields to uppercase for consistent storage and display.
    Uses SQLAlchemy events for seamless normalization without breaking type hints.
    """
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)

    # Store General and Detail parts separately for easy querying
    # These are automatically converted to uppercase via SQLAlchemy events
    general = Column(Text, nullable=False, index=True)  # e.g., "FOOD"
    detail = Column(Text, nullable=False, index=True)  # e.g., "GROCERIES"
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    recipients = relationship("Recipient", back_populates="default_category")
    transactions = relationship("Transaction", back_populates="category")
    planned_transactions = relationship("PlannedTransaction", back_populates="category")

    # Table-level constraints
    __table_args__ = (
        UniqueConstraint('general', 'detail', name='uq_general_detail'),
    )

    def __init__(self, **kwargs):
        """Initialize category with automatic uppercase normalization."""
        # Normalize general and detail to uppercase before calling super().__init__
        if 'general' in kwargs and kwargs['general']:
            kwargs['general'] = kwargs['general'].strip().upper()
        if 'detail' in kwargs and kwargs['detail']:
            kwargs['detail'] = kwargs['detail'].strip().upper()
        super().__init__(**kwargs)

    def set_general(self, value: str) -> None:
        """Set the general category name (automatically converted to uppercase)."""
        if value:
            self.general = value.strip().upper()
        else:
            self.general = value

    def set_detail(self, value: str) -> None:
        """Set the detail category name (automatically converted to uppercase)."""
        if value:
            self.detail = value.strip().upper()
        else:
            self.detail = value

    def full_path(self) -> str:
        """Get the full category path in General:Detail format (uppercase)."""
        return f"{self.general}:{self.detail}"

    @property
    def category_name(self) -> str:
        """Property alias for full_path() to match schema field name.

        Returns the full category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES').
        This property provides a consistent interface for API responses.

        Returns:
            str: Full category path in 'General:Detail' format (uppercase).
        """
        return self.full_path()


# SQLAlchemy event listeners for automatic uppercase normalization
@event.listens_for(Category.general, 'set')
def normalize_general(target, value, oldvalue, initiator):
    """Automatically normalize general field to uppercase using TextNormalizationService."""
    from services.text_normalization_service import TextNormalizationService
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_category_name(value)
    return value


@event.listens_for(Category.detail, 'set')
def normalize_detail(target, value, oldvalue, initiator):
    """Automatically normalize detail field to uppercase using TextNormalizationService."""
    from services.text_normalization_service import TextNormalizationService
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_category_name(value)
    return value


class Recipient(Base):
    """
    Recipient model - stores information about transaction recipients/payees
    """
    __tablename__ = "recipients"

    id = Column(Integer, primary_key=True, index=True)

    name = Column(Text, nullable=False, index=True)
    account_number = Column(Text, nullable=True)
    default_category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    notes = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    transactions = relationship("Transaction", back_populates="recipient")
    planned_transactions = relationship("PlannedTransaction", back_populates="recipient")
    default_category = relationship("Category", back_populates="recipients")

    __table_args__ = (
        UniqueConstraint('account_number', name='uq_account_number'),
    )

    @property
    def default_category_name(self) -> Optional[str]:
        """Get the default category name in 'General:Detail' format.

        Returns the full category path for the recipient's default category,
        or None if no default category is assigned. This property provides
        easy access to the category name for API responses.

        Returns:
            Optional[str]: Category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES'),
                          or None if no default category is set.
        """
        if self.default_category:
            return self.default_category.full_path()
        return None


class ImportBatch(Base):
    """
    ImportBatch model - tracks CSV import operations
    """
    __tablename__ = "import_batches"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String(255), nullable=False)
    bank_name = Column(String(100), nullable=False)

    # Import statistics
    total_processed = Column(Integer, default=0)
    imported_count = Column(Integer, default=0)
    duplicate_count = Column(Integer, default=0)
    error_count = Column(Integer, default=0)

    # Import metadata
    config_used = Column(Text, nullable=True)  # JSON config for reproducibility
    status = Column(String(20), default="processing")  # processing, completed, failed
    error_message = Column(Text, nullable=True)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    completed_at = Column(DateTime, nullable=True)

    # Relationships
    transactions = relationship("Transaction", back_populates="import_batch")


class PlannedTransaction(Base):
    """
    PlannedTransaction model - stores future/planned financial transactions

    Similar to Transaction but for transactions that haven't occurred yet.
    Used for budgeting, forecasting, and recurring transaction management.

    For recurring transactions, the same planned transaction can be executed multiple times.
    Each execution is tracked in the PlannedTransactionExecution table.
    """
    __tablename__ = "planned_transactions"

    id = Column(Integer, primary_key=True, index=True)

    # Core planned transaction data
    planned_date = Column(Date, nullable=False, index=True)  # When the transaction is expected
    amount = Column(Numeric(10, 2), nullable=False)
    currency = Column(String(3), nullable=True)  # Currency code (EUR, USD, etc.)
    memo = Column(Text, nullable=True)
    comment = Column(Text, nullable=True)  # Additional notes
    bank_account = Column(Text, nullable=True, index=True)  # Target bank/account

    # Foreign keys
    recipient_id = Column(Integer, ForeignKey("recipients.id"), nullable=False)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)

    # Planned transaction specific fields
    is_recurring = Column(Boolean, default=False, nullable=False)  # Whether this repeats
    recurrence_pattern = Column(Text, nullable=True)  # e.g., "monthly", "weekly", JSON pattern
    is_executed = Column(Boolean, default=False, nullable=False)  # Currently pending execution
    last_executed_date = Column(Date, nullable=True)  # Date of last execution (for recurring)

    # Soft deletion support
    is_active = Column(Boolean, default=True, nullable=False)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    recipient = relationship("Recipient", back_populates="planned_transactions")
    category = relationship("Category", back_populates="planned_transactions")
    executions = relationship("PlannedTransactionExecution", back_populates="planned_transaction",
                              cascade="all, delete-orphan", order_by="desc(PlannedTransactionExecution.execution_date)")

    @property
    def executed_transaction_id(self) -> Optional[int]:
        """Get the most recent executed transaction ID.

        Returns the ID of the most recent executed transaction from the execution history.
        This property maintains backward compatibility with code expecting executed_transaction_id.

        Returns:
            Optional[int]: Most recent transaction ID, or None if never executed.
        """
        if self.executions and len(self.executions) > 0:
            return self.executions[0].executed_transaction_id
        return None

    @property
    def category_name(self) -> Optional[str]:
        """Get the category name in 'General:Detail' format.

        Returns the full category path for the planned transaction's category.
        If the transaction doesn't have a direct category assigned (category_id is None),
        falls back to the recipient's default category.

        Returns:
            Optional[str]: Category name in 'General:Detail' format (e.g., 'FOOD:GROCERIES').
        """
        # Priority 1: Planned transaction's direct category assignment
        if self.category:
            return self.category.full_path()

        # Priority 2: Recipient's default category (fallback)
        if self.recipient and self.recipient.default_category:
            return self.recipient.default_category.full_path()

        return None

    @property
    def recipient_name(self) -> Optional[str]:
        """Get the recipient name for this planned transaction.

        Returns:
            Optional[str]: Recipient name (in UPPERCASE), or None if no recipient is set.
        """
        if self.recipient:
            return self.recipient.name
        return None


class ExchangeRate(Base):
    """
    ExchangeRate model - stores currency exchange rates for EUR base currency

    Caches exchange rates in the database to minimize API calls and provide
    offline functionality. Rates are stored with their fetch date and can be
    historical or current.
    """
    __tablename__ = "exchange_rates"

    id = Column(Integer, primary_key=True, index=True)

    # Currency information
    currency_code = Column(String(3), nullable=False, index=True)  # ISO 4217 code (USD, GBP, etc.)
    rate_to_eur = Column(Numeric(20, 10), nullable=False)  # Exchange rate: 1 CURRENCY = X EUR

    # Rate metadata
    rate_date = Column(Date, nullable=False, index=True)  # The date this rate is valid for
    is_latest = Column(Boolean, default=False, index=True)  # True if this is the latest rate

    # Timestamps
    fetched_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, onupdate=func.now())

    # Table constraints
    __table_args__ = (
        UniqueConstraint('currency_code', 'rate_date', name='uq_currency_date'),
    )


class PlannedTransactionExecution(Base):
    """
    PlannedTransactionExecution model - tracks execution history of planned transactions

    This table maintains an audit trail of all executions of a planned transaction,
    enabling recurring transactions to be executed multiple times while tracking
    each individual payment.
    """
    __tablename__ = "planned_transaction_executions"

    id = Column(Integer, primary_key=True, index=True)

    # Foreign keys
    planned_transaction_id = Column(Integer, ForeignKey("planned_transactions.id", ondelete="CASCADE"),
                                    nullable=False, index=True)
    executed_transaction_id = Column(Integer, ForeignKey("transactions.id", ondelete="CASCADE"),
                                     nullable=False)

    # Execution metadata
    execution_date = Column(Date, nullable=False)  # Date when the execution was recorded

    # Timestamps
    created_at = Column(DateTime, server_default=func.now())

    # Relationships
    planned_transaction = relationship("PlannedTransaction", back_populates="executions")
    executed_transaction = relationship("Transaction")
