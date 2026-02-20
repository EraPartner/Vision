from typing import Optional

from sqlalchemy import Column, Integer, String, DateTime, Date, Numeric, Text, UniqueConstraint, ForeignKey, \
    Boolean, event, Index, CheckConstraint
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.sql import func

Base = declarative_base()


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        Index('idx_transaction_date_recipient', 'date', 'recipient_id'),
        CheckConstraint("length(currency) = 3 OR currency IS NULL", name='ck_transactions_currency_len'),
    )

    id = Column(Integer, primary_key=True, index=True)

    # Core transaction data
    date = Column(Date, nullable=False, index=True)  # Changed from DateTime to Date
    # Use Numeric(15, 2) to match raw tables and allow sufficiently large amounts while keeping 2 decimal places
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=True)  # Currency code (EUR, USD, etc.)
    balance = Column(Numeric(15, 2), nullable=True)  # Account balance after transaction
    memo = Column(Text, nullable=True)
    comment = Column(Text, nullable=True)  # Additional comment field for bank-specific data
    bank_account = Column(Text, nullable=True,
                          index=True)  # Which bank/account (e.g., "Revolut", "KBC Checking Account")

    # Foreign keys
    recipient_id = Column(Integer, ForeignKey("recipients.id"), nullable=False, index=True)
    recipient_bank_account_id = Column(Integer, ForeignKey("recipient_bank_accounts.id"), nullable=True, index=True)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True, index=True)

    # Soft deletion support
    is_active = Column(Boolean, default=True, nullable=False)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    recipient = relationship("Recipient", back_populates="transactions")
    recipient_bank_account = relationship("RecipientBankAccount", back_populates="transactions")
    category = relationship("Category", back_populates="transactions")
    # One-to-one link to raw reference. Use passive_deletes so DB ON DELETE CASCADE is relied on
    # (avoids SQLAlchemy loading/deleting the child explicitly).
    raw_reference = relationship(
        "TransactionRawReference",
        back_populates="transaction",
        uselist=False,
        passive_deletes=True,
    )

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

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<Transaction id={self.id} date={self.date} amount={self.amount}>"


# SQLAlchemy event listeners for automatic uppercase normalization of Transaction fields
@event.listens_for(Transaction.memo, 'set')
def normalize_transaction_memo(target, value, oldvalue, initiator):
    """Automatically normalize transaction memo to uppercase."""
    from services.text_normalization_service import TextNormalizationService
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_recipient_name(value)
    return value


@event.listens_for(Transaction.currency, 'set')
def normalize_transaction_currency(target, value, oldvalue, initiator):
    """Automatically normalize transaction currency to uppercase and validate ISO 4217 length (3)."""
    if value and isinstance(value, str):
        v = value.strip().upper()
        if len(v) != 3 or not v.isalpha():
            raise ValueError(f"Invalid currency code: {value!r}. Expected 3-letter ISO 4217 code.")
        return v
    return value


@event.listens_for(Transaction.bank_account, 'set')
def normalize_transaction_bank_account(target, value, oldvalue, initiator):
    """Automatically normalize transaction bank_account to uppercase."""
    from services.text_normalization_service import TextNormalizationService
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_recipient_name(value)
    return value


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
        """Compatibility property for API schemas.

        Pydantic response models use `from_attributes=True` and expect an attribute
        named `category_name` on the SQLAlchemy model. Expose the computed
        full path via this property so serialization succeeds without extra
        transformation in the API layer.
        """
        return self.full_path()

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<Category id={self.id} name={self.full_path()!r}>"


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

    Represents a unique person or entity. Each recipient can have multiple bank accounts
    through the RecipientBankAccount junction table.
    """
    __tablename__ = "recipients"

    id = Column(Integer, primary_key=True, index=True)

    name = Column(Text, nullable=False, index=True)
    normalized_name = Column(Text, nullable=False, unique=True, index=True)
    default_category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    bank_accounts = relationship("RecipientBankAccount", back_populates="recipient", cascade="all, delete-orphan")
    transactions = relationship("Transaction", back_populates="recipient")
    planned_transactions = relationship("PlannedTransaction", back_populates="recipient")
    default_category = relationship("Category", back_populates="recipients")

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

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<Recipient id={self.id} name={self.name!r}>"


# SQLAlchemy event listeners for automatic uppercase normalization of Recipient fields
@event.listens_for(Recipient.name, 'set')
def normalize_recipient_name(target, value, oldvalue, initiator):
    """Automatically normalize recipient name to uppercase, preserving URLs."""
    if value and isinstance(value, str):
        from services.text_normalization_service import TextNormalizationService
        import re

        # Check if entire string is a URL
        value_lower = value.lower()
        if (value_lower.startswith('http://') or
                value_lower.startswith('https://') or
                value_lower.startswith('www.') or
                '://' in value or
                re.match(r'^[a-z0-9-]+\.[a-z]{2,}', value_lower)):
            return value

        # Check for URLs within the text and preserve them
        url_pattern = r'((?:https?://)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:/[^\s]*)?)'
        urls = re.findall(url_pattern, value, re.IGNORECASE)

        if urls:
            # Replace URLs with placeholders, normalize, then restore
            placeholder_map = {}
            modified_value = value
            for i, url in enumerate(urls):
                placeholder = f"__URL_PLACEHOLDER_{i}__"
                placeholder_map[placeholder] = url
                modified_value = modified_value.replace(url, placeholder)

            normalized = TextNormalizationService.normalize_recipient_name(modified_value)

            for placeholder, url in placeholder_map.items():
                normalized = normalized.replace(placeholder, url)

            return normalized

        return TextNormalizationService.normalize_recipient_name(value)
    return value


@event.listens_for(Recipient, 'before_insert')
@event.listens_for(Recipient, 'before_update')
def set_normalized_name(mapper, connection, target):
    """Automatically set normalized_name from name before insert/update."""
    if target.name:
        from services.text_normalization_service import TextNormalizationService
        target.normalized_name = TextNormalizationService.normalize_name_for_matching(target.name)


class RecipientBankAccount(Base):
    """
    RecipientBankAccount model - junction table linking recipients to their bank accounts

    Allows a single recipient (person/entity) to have multiple bank accounts across different banks.
    This prevents duplicate recipients when banks format names differently.
    """
    __tablename__ = "recipient_bank_accounts"

    id = Column(Integer, primary_key=True, index=True)
    recipient_id = Column(Integer, ForeignKey("recipients.id"), nullable=False)
    # Use a bounded String(34) for IBAN/account numbers to match raw tables and ISO IBAN max length
    account_number = Column(String(34), nullable=False, unique=True, index=True)
    bank_name = Column(Text, nullable=True)
    account_label = Column(Text, nullable=True)
    address = Column(Text, nullable=True)
    is_primary = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)

    # Timestamps - using UTC for consistency
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, onupdate=func.now())

    # Relationships
    recipient = relationship("Recipient", back_populates="bank_accounts")
    transactions = relationship("Transaction", back_populates="recipient_bank_account")

    @property
    def recipient_name(self) -> Optional[str]:
        """Get the recipient name for this bank account."""
        if self.recipient:
            return self.recipient.name
        return None

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<RecipientBankAccount id={self.id} account={self.account_number!r} recipient_id={self.recipient_id}>"


# SQLAlchemy event listeners for automatic uppercase normalization of RecipientBankAccount fields
@event.listens_for(RecipientBankAccount.account_number, 'set')
def normalize_bank_account_number(target, value, oldvalue, initiator):
    """Automatically normalize bank account number to uppercase and validate IBAN-like format.

    Basic validation: uppercased, at most 34 characters, and contains only alphanumeric characters.
    This is intentionally lightweight — full IBAN validation (checksum) can be added via a util
    or external library if desired.
    """
    if value and isinstance(value, str):
        v = value.strip().upper()
        # Basic checks
        if len(v) > 34:
            raise ValueError(f"Account number too long (>{34}): {v!r}")
        # Allow characters A-Z and 0-9 and spaces (spaces removed earlier), but reject other punctuation
        if not all(c.isalnum() for c in v):
            raise ValueError(f"Account number contains invalid characters: {v!r}")
        # Full IBAN checksum validation if looks like IBAN (starts with 2 letters then digits)
        try:
            from services.iban import is_valid_iban
        except Exception:
            # If the validator isn't available for any reason, fallback to basic checks only
            return v

        # Run validator and raise if invalid
        if not is_valid_iban(v):
            raise ValueError(f"Invalid IBAN/account number checksum: {v!r}")
        return v
    return value


@event.listens_for(RecipientBankAccount.bank_name, 'set')
def normalize_bank_name(target, value, oldvalue, initiator):
    """Automatically normalize bank name to uppercase."""
    from services.text_normalization_service import TextNormalizationService
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_recipient_name(value)
    return value


@event.listens_for(RecipientBankAccount.address, 'set')
def normalize_bank_account_address(target, value, oldvalue, initiator):
    """Automatically normalize bank account address to uppercase."""
    from services.text_normalization_service import TextNormalizationService
    if value and isinstance(value, str):
        return TextNormalizationService.normalize_recipient_name(value)
    return value


class PlannedTransaction(Base):
    """
    PlannedTransaction model - stores future/planned financial transactions

    Similar to Transaction but for transactions that haven't occurred yet.
    Used for budgeting, forecasting, and recurring transaction management.

    For recurring transactions, the same planned transaction can be executed multiple times.
    Each execution is tracked in the PlannedTransactionExecution table.
    """
    __tablename__ = "planned_transactions"
    __table_args__ = (
        CheckConstraint("length(currency) = 3 OR currency IS NULL", name='ck_planned_transactions_currency_len'),
    )

    id = Column(Integer, primary_key=True, index=True)

    # Core planned transaction data
    planned_date = Column(Date, nullable=False, index=True)  # When the transaction is expected
    amount = Column(Numeric(15, 2), nullable=False)
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

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<PlannedTransaction id={self.id} date={self.planned_date} amount={self.amount}>"


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
        CheckConstraint('rate_to_eur > 0', name='ck_exchange_rate_positive'),
    )

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<ExchangeRate {self.currency_code} @ {self.rate_date} = {self.rate_to_eur}>"


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

    def __repr__(self) -> str:  # pragma: no cover - convenience
        return f"<PlannedTransactionExecution id={self.id} planned_tx_id={self.planned_transaction_id} executed_tx_id={self.executed_transaction_id} date={self.execution_date}>"


# Ensure dependent raw transaction models are imported so their mapped classes
# (e.g., TransactionRawReference) are registered with SQLAlchemy before any
# mapper configuration occurs. This avoids "failed to locate a name"
# errors when a relationship references a class defined in a separate module.
# Importing here is a no-op if the module was already imported elsewhere.
try:
    # Import using package-relative name to ensure module is loaded in all contexts
    from database import raw_transaction_models  # noqa: F401  (register models)
except Exception:
    # Import failure should not break module import; raise in debug/test contexts
    # but keep the application resilient in environments where raw models
    # may not be available (e.g., lightweight scripts). Log if available.
    try:
        import logging

        logging.getLogger(__name__).warning(
            'Could not import raw_transaction_models; some relationships may be unresolved until imported.')
    except Exception:
        pass
