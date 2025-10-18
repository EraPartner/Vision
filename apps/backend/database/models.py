from sqlalchemy import Column, Integer, String, DateTime, Date, Numeric, Text, Index, UniqueConstraint, ForeignKey, \
    Boolean
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
    bank_account = Column(String(100), nullable=True,
                          index=True)  # Which bank/account (e.g., "Revolut", "KBC Checking Account")

    # Foreign keys
    recipient_id = Column(Integer, ForeignKey("recipients.id"), nullable=False)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    batch_id = Column(Integer, ForeignKey("import_batches.id"), nullable=True)

    # Import metadata
    original_raw_data = Column(Text, nullable=True)  # Store original CSV row
    bank_reference = Column(String(100), nullable=True)  # Bank's transaction ID

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    recipient = relationship("Recipient", back_populates="transactions")
    category = relationship("Category", back_populates="transactions")
    import_batch = relationship("ImportBatch", back_populates="transactions")


class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False,
                  index=True)  # Changed from unique to allow same name in different hierarchies
    description = Column(Text, nullable=True)
    color = Column(String(7), nullable=True)  # Hex color code for UI
    parent_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    is_active = Column(Boolean, default=True)

    # New field to store the type (general or detailed)
    category_type = Column(String(20), nullable=True)  # 'general' or 'detailed'

    # Full path for easy queries (e.g., "Food:Meat")
    full_path = Column(String(200), nullable=True, unique=True, index=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    recipients = relationship("Recipient", back_populates="default_category")
    transactions = relationship("Transaction", back_populates="category")
    # Self-referential for subcategories
    parent = relationship("Category", remote_side=[id], back_populates="children")
    children = relationship("Category", back_populates="parent")

    # Add constraint to ensure unique path
    __table_args__ = (
        Index('idx_category_path', 'full_path'),
    )


class BankAdapter(Base):
    __tablename__ = "bank_adapters"

    id = Column(Integer, primary_key=True, index=True)
    bank_name = Column(String(100), nullable=False, unique=True)
    adapter_config = Column(Text, nullable=False)  # JSON configuration
    is_active = Column(String(10), default="true", nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)


class Recipient(Base):
    """
    Recipient model - stores information about transaction recipients/payees
    Designed to be extensible for future category assignments
    """
    __tablename__ = "recipients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    account_number = Column(String(50), nullable=True)  # Current requirement

    # Future extensibility fields
    default_category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    transactions = relationship("Transaction", back_populates="recipient")
    default_category = relationship("Category", back_populates="recipients")


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

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    transactions = relationship("Transaction", back_populates="import_batch")
