"""Import Batch Repository module.

This module provides data access operations for ImportBatch entities using the repository pattern.
It centralises all database operations related to import batches, providing a clean abstraction
layer between the service layer and the database models.

The repository is responsible for:
- CRUD operations for import batches
- Querying import batch history
- Filtering and pagination support
- Data persistence and transaction management

Classes:
    ImportBatchRepository: Repository for import batch data access operations.
"""
from typing import List, Optional

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import ImportBatch

logger = setup_logging(__name__)


class ImportBatchRepository:
    """Repository for ImportBatch data access operations.

    Provides centralised data access for import batch entities, abstracting
    database operations and providing a clean interface for the service layer.
    All database queries and persistence operations for import batches are
    handled through this repository.

    The repository handles:
    - Creating and updating import batch records
    - Retrieving import batches by ID
    - Listing recent import batches
    - Querying import batch history with filtering

    Attributes:
        db (Session): SQLAlchemy database session for executing queries.

    Example:
        repo = ImportBatchRepository(db_session)
        recent_batches = repo.list_recent(limit=10)
        batch = repo.get_by_id(batch_id=1)
    """

    def __init__(self, db: Session):
        """Initialise the import batch repository with a database session.

        Args:
            db (Session): SQLAlchemy database session for executing queries.
        """
        self.db = db

    def list_recent(self, limit: int = 10, offset: int = 0) -> List[ImportBatch]:
        """Retrieve recent import batches ordered by creation date.

        Retrieves import batches ordered by creation date descending (newest first)
        with support for pagination.

        Args:
            limit (int): Maximum number of batches to return. Defaults to 10.
            offset (int): Number of batches to skip before returning results. Defaults to 0.

        Returns:
            List[ImportBatch]: List of recent import batches, ordered by created_at descending.

        Example:
            repo = ImportBatchRepository(db)

            # Get 10 most recent batches
            recent = repo.list_recent()

            # Get next page with pagination
            next_page = repo.list_recent(limit=10, offset=10)
        """
        return (
            self.db.query(ImportBatch)
            .order_by(ImportBatch.created_at.desc())
            .limit(limit)
            .offset(offset)
            .all()
        )

    def create(self, batch: ImportBatch) -> ImportBatch:
        """Create a new import batch record.

        Persists a new import batch to the database and returns the created entity
        with all database-generated fields populated (id, timestamps, etc.).

        Args:
            batch (ImportBatch): The import batch entity to create.

        Returns:
            ImportBatch: The created import batch with database-generated fields populated.

        Example:
            repo = ImportBatchRepository(db)
            batch = ImportBatch(
                filename="transactions.csv",
                bank_name="Chase",
                status="processing"
            )
            created = repo.create(batch)
            print(f"Created batch with ID: {created.id}")

        Note:
            - Automatically commits the transaction
            - Refreshes the entity to include database-generated values
        """
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)
        logger.info(
            f"Created import batch",
            extra={
                "operation": "create_batch",
                "batch_id": batch.id,
                "file_name": batch.filename,
                "bank_name": batch.bank_name
            }
        )
        return batch

    def update(self, batch: ImportBatch) -> ImportBatch:
        """Update an existing import batch record.

        Persists changes to an existing import batch and returns the updated entity.

        Args:
            batch (ImportBatch): The import batch entity to update.

        Returns:
            ImportBatch: The updated import batch with latest database values.

        Example:
            repo = ImportBatchRepository(db)
            batch = repo.get_by_id(1)
            batch.status = "completed"
            batch.imported_count = 150
            updated = repo.update(batch)

        Note:
            - Assumes the batch entity is already attached to the session
            - Commits the transaction and refreshes the entity
        """
        self.db.commit()
        self.db.refresh(batch)
        logger.info(
            f"Updated import batch",
            extra={
                "operation": "update_batch",
                "batch_id": batch.id,
                "status": batch.status
            }
        )
        return batch

    def get_by_id(self, batch_id: int) -> Optional[ImportBatch]:
        """Retrieve an import batch by its unique identifier.

        Args:
            batch_id (int): The unique identifier of the import batch.

        Returns:
            Optional[ImportBatch]: The import batch if found, None otherwise.

        Example:
            repo = ImportBatchRepository(db)
            batch = repo.get_by_id(1)
            if batch:
                print(f"Found batch: {batch.filename}")
            else:
                print("Batch not found")
        """
        return self.db.query(ImportBatch).filter(ImportBatch.id == batch_id).first()

    def get_total_count(self) -> int:
        """Get total count of all import batches.

        Returns:
            int: Total number of import batches in the database.

        Example:
            repo = ImportBatchRepository(db)
            total = repo.get_total_count()
            print(f"Total batches: {total}")
        """
        return self.db.query(ImportBatch).count()

    def get_by_bank_name(self, bank_name: str, limit: int = 10, offset: int = 0) -> List[ImportBatch]:
        """Retrieve import batches filtered by bank name.

        Args:
            bank_name (str): Bank name to filter by (case-insensitive).
            limit (int): Maximum number of batches to return. Defaults to 10.
            offset (int): Number of batches to skip. Defaults to 0.

        Returns:
            List[ImportBatch]: List of import batches for the specified bank.

        Example:
            repo = ImportBatchRepository(db)
            chase_batches = repo.get_by_bank_name("Chase")
        """
        return (
            self.db.query(ImportBatch)
            .filter(ImportBatch.bank_name.ilike(f"%{bank_name}%"))
            .order_by(ImportBatch.created_at.desc())
            .limit(limit)
            .offset(offset)
            .all()
        )

    def get_by_status(self, status: str, limit: int = 10, offset: int = 0) -> List[ImportBatch]:
        """Retrieve import batches filtered by status.

        Args:
            status (str): Status to filter by (e.g., 'completed', 'failed', 'processing').
            limit (int): Maximum number of batches to return. Defaults to 10.
            offset (int): Number of batches to skip. Defaults to 0.

        Returns:
            List[ImportBatch]: List of import batches with the specified status.

        Example:
            repo = ImportBatchRepository(db)
            failed_batches = repo.get_by_status("failed")
        """
        return (
            self.db.query(ImportBatch)
            .filter(ImportBatch.status == status)
            .order_by(ImportBatch.created_at.desc())
            .limit(limit)
            .offset(offset)
            .all()
        )
