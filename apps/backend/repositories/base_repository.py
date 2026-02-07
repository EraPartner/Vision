"""Base Repository interface.

Defines a minimal abstract contract for repository classes to standardise
common data access operations across domain resources (e.g., recipients,
categories). The goal is uniformity of method names and behaviours without
over-engineering.

All repositories should implement these methods with consistent semantics:
- Listing with optional filters and pagination
- Single entity retrieval by id
- Create, update, soft delete, hard delete
- Total and filtered counts

This uniform contract improves testability, maintainability, and aids API
layer consistency for pagination and audit logging.

Example:
    class RecipientRepository(BaseRepository):
        def get_by_id(self, entity_id: int) -> Optional[SupportsId]:
            ...

        # Implement other abstract methods following the same contract.

Notes:
    - Responses should be deterministic where ordering is implied to ensure
      stable pagination.
    - All concrete implementations MUST perform structured JSON logging for
      auditability in financial domains.
    - Filters accepted by list_active MUST be mirrored by get_filtered_count.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class SupportsId(Protocol):
    """Protocol representing models that expose an integer `id` attribute.

    This protocol enables static type checking for repository contracts while
    remaining framework-agnostic. Any domain model that includes an integer
    primary key can satisfy this protocol.

    Attributes:
        id (int): Unique identifier for the entity.
    """

    id: int


class BaseRepository(ABC):
    """Abstract base class for domain repositories.

    Implementations should encapsulate ORM specifics and expose methods
    operating on domain models, returning model instances rather than raw
    queries. Methods MUST apply active filtering consistently when `active=True`.

    Purpose:
        Provide a uniform, minimal contract across repositories to simplify
        service-layer logic, API pagination, and audit logging. This is
        particularly important for financial systems where traceability and
        consistency are critical.

    Usage:
        Subclass this base and implement all abstract methods with consistent
        semantics and deterministic ordering. Ensure that any filters supported
        by `list_active` are identically supported by `get_filtered_count`.

    Example:
        class CategoryRepository(BaseRepository):
            def list_active(self, limit=None, offset=None, active=True, **filters):
                # ... apply filters and return List[Category]
                return []

            def get_total_count(self, active: bool = True) -> int:
                # ... count categories
                return 0
    """

    @abstractmethod
    def get_by_id(self, entity_id: int) -> Optional[SupportsId]:
        """Retrieve a single entity by its primary key id.

        Retrieves a single entity regardless of its active status.

        Args:
            entity_id (int): Unique identifier of the entity to retrieve.

        Returns:
            Optional[SupportsId]: The entity if found; None otherwise.

        Notes:
            - MUST include inactive records (no active filter).
            - SHOULD avoid raising on missing records; return None for absent ids.
        """

    @abstractmethod
    def create(self, entity: SupportsId) -> SupportsId:
        """Persist a new entity and return the refreshed instance.

        The concrete implementation SHOULD commit the transaction and refresh
        the instance so auto-generated fields (e.g., id) are available.

        Args:
            entity (SupportsId): Domain model instance prepared for insertion.

        Returns:
            SupportsId: The created instance with database-generated fields.
        """

    @abstractmethod
    def update(self, entity: SupportsId) -> SupportsId:
        """Persist changes to an existing entity and return the refreshed instance.

        Implementations SHOULD commit the transaction and refresh the instance
        to reflect persisted state.

        Args:
            entity (SupportsId): Tracked domain model instance with modifications.

        Returns:
            SupportsId: The updated instance reflecting database state.
        """

    @abstractmethod
    def soft_delete(self, entity: SupportsId) -> None:
        """Mark an entity inactive (soft delete) and commit the change.

        Soft deletion MUST preserve the record for auditability. Typically this
        sets an `is_active` or equivalent flag to False.

        Args:
            entity (SupportsId): Domain model instance to mark inactive.
        """

    @abstractmethod
    def hard_delete(self, entity: SupportsId) -> None:
        """Permanently remove an entity and commit the transaction.

        Use with caution in financial systems. Prefer soft deletion unless the
        record is safe to fully remove (e.g., temporary or non-audited data).

        Args:
            entity (SupportsId): Domain model instance to permanently delete.
        """

    @abstractmethod
    def list_active(
            self,
            limit: Optional[int] = None,
            offset: Optional[int] = None,
            active: bool = True,
            **filters: Any,
    ) -> List[SupportsId]:
        """List entities with optional filters and pagination.

        MUST apply the same filters as used in `get_filtered_count`.
        Ordering SHOULD be deterministic to ensure stable pagination.

        Args:
            limit (int | None): Maximum number of rows to return.
            offset (int | None): Number of rows to skip before returning results.
            active (bool): When True, include only active entities; when False,
                include both active and inactive.
            **filters: Arbitrary filter parameters specific to the domain model.

        Returns:
            List[SupportsId]: Entities matching filters with deterministic ordering.
        """

    @abstractmethod
    def get_total_count(self, active: bool = True) -> int:
        """Return the total number of entities, filtered by `active`.

        Args:
            active (bool): When True, count only active entities; when False,
                count both active and inactive.

        Returns:
            int: Total count matching the active filter.
        """

    @abstractmethod
    def get_filtered_count(self, active: bool = True, **filters: Any) -> int:
        """Return the count of entities matching the provided filters.

        Filters MUST mirror those accepted by `list_active`. This method is
        intended to support pagination calculations when filters are applied.

        Args:
            active (bool): When True, count only active entities; when False,
                count both active and inactive.
            **filters: Arbitrary filter parameters identical to `list_active`.

        Returns:
            int: Count of entities matching the specified filters and active flag.
        """
