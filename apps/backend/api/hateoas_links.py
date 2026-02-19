"""
Centralised HATEOAS links factory for REST Level 3 API discovery.

This module provides factory functions for generating consistent hypermedia links
across all API endpoints, ensuring uniform link patterns and discoverability.
"""
from typing import List

from fastapi import Request
from pydantic import HttpUrl

from api.api_schemas import Link


# ==================== Helpers ====================

def get_base_url(request: Request) -> str:
    """Extract and normalise base URL from request."""
    return str(request.base_url).rstrip('/')


def normalise_resource_type_to_singular(resource_type: str) -> str:
    """Normalise resource type (e.g., 'transactions', 'recipients', etc.) to singular."""
    if resource_type == 'categories':
        return 'category'
    return str(resource_type).lower()[:-1]


# ==================== Root/Discovery Links ====================

def get_root_links(request: Request) -> List[Link]:
    """
    Generate links for the API root discovery endpoint.

    Returns:
        List of links to all major resource endpoints
    """
    base_url = get_base_url(request)
    return [
        Link(rel="self", href=HttpUrl(f"{base_url}/api/"), method="GET", title="API root"),
        Link(rel="admin", href=HttpUrl(f"{base_url}/api/admin"), method="GET", title="Admin status"),
        Link(rel="categories", href=HttpUrl(f"{base_url}/api/categories"), method="GET", title="List categories"),
        Link(rel="transactions", href=HttpUrl(f"{base_url}/api/transactions"), method="GET", title="List transactions"),
        Link(rel="recipients", href=HttpUrl(f"{base_url}/api/recipients"), method="GET", title="List recipients"),
        Link(rel="info", href=HttpUrl(f"{base_url}/api/info"), method="GET", title="View info"),
        Link(rel="import", href=HttpUrl(f"{base_url}/api/import/csv"), method="POST", title="Import transactions"),
    ]


# ==================== Resource Links ====================

def get_resource_links(request: Request, resource_type: str, resource_id: int) -> List[Link]:
    """
    Generate standard links for a single resource (self, update, delete, list).

    Args:
        request: FastAPI Request object
        resource_type: Type of resource ('categories', 'transactions', 'recipients', etc.)
        resource_id: ID of the resource

    Returns:
        List of resource links
    """
    base_url = get_base_url(request)

    return [
        Link(
            rel="self",
            href=HttpUrl(f"{base_url}/api/{resource_type}/{resource_id}"),
            method="GET",
            title=f"Get this {normalise_resource_type_to_singular(resource_type)}"
        ),
        Link(
            rel="update",
            href=HttpUrl(f"{base_url}/api/{resource_type}/{resource_id}"),
            method="PATCH",
            title=f"Update this {normalise_resource_type_to_singular(resource_type)}"
        ),
        Link(
            rel="delete",
            href=HttpUrl(f"{base_url}/api/{resource_type}/{resource_id}"),
            method="DELETE",
            title=f"Delete this {normalise_resource_type_to_singular(resource_type)}"
        ),
        Link(
            rel="list",
            href=HttpUrl(f"{base_url}/api/{resource_type}"),
            method="GET",
            title=f"List all {resource_type}"
        ),
    ]


def get_deletion_response_links(request: Request, resource_type: str) -> List[Link]:
    """
    Generate links after successful deletion (list, create).

    Args:
        request: FastAPI Request object
        resource_type: Type of resource

    Returns:
        List of links after deletion
    """
    base_url = get_base_url(request)
    return [
        Link(
            rel="list",
            href=HttpUrl(f"{base_url}/api/{resource_type}"),
            method="GET",
            title=f"List remaining {resource_type}"
        ),
        Link(
            rel="create",
            href=HttpUrl(f"{base_url}/api/{resource_type}"),
            method="POST",
            title=f"Create a new {normalise_resource_type_to_singular(resource_type)}"
        ),
    ]


# ==================== Collection Links ====================

def get_collection_links(
        request: Request,
        resource_type: str,
        limit: int,
        offset: int,
        total: int,
        **query_params
) -> List[Link]:
    """
    Generate collection links including pagination and create action.

    Provides complete navigation for list endpoints: self, prev, next, and create.
    All query parameters are preserved across pagination links for consistent filtering.

    Args:
        request: FastAPI Request object
        resource_type: Type of resource ('categories', 'transactions', 'recipients', etc.)
        limit: Current page limit
        offset: Current page offset
        total: Total number of items
        **query_params: Additional query parameters to include in links (filters, sorting, etc.)

    Returns:
        List of collection links including pagination and actions

    Example:
        # For GET /api/recipients?name=john&limit=10&offset=20
        links = get_collection_links(request, "recipients", 10, 20, 100, name="john")
        # Returns: [self, prev, next, create] with name=john preserved in all navigation links
    """
    base_url = get_base_url(request)
    endpoint = f"/api/{resource_type}"

    # Build query string from additional parameters (filters, etc.)
    query_string = ''.join(f"&{k}={v}" for k, v in query_params.items() if v is not None)

    # Self link - current page
    links = [
        Link(
            rel="self",
            href=HttpUrl(f"{base_url}{endpoint}?limit={limit}&offset={offset}{query_string}"),
            method="GET",
            title="Current page"
        )
    ]

    # Previous link - only if not on first page
    if offset > 0:
        new_offset = max(0, offset - limit)
        links.append(
            Link(
                rel="prev",
                href=HttpUrl(f"{base_url}{endpoint}?limit={limit}&offset={new_offset}{query_string}"),
                method="GET",
                title="Previous page"
            )
        )

    # Next link - only if there are more items
    if offset + limit < total:
        new_offset = offset + limit
        links.append(
            Link(
                rel="next",
                href=HttpUrl(f"{base_url}{endpoint}?limit={limit}&offset={new_offset}{query_string}"),
                method="GET",
                title="Next page"
            )
        )

    # Create action link
    links.append(
        Link(
            rel="create",
            href=HttpUrl(f"{base_url}{endpoint}"),
            method="POST",
            title=f"Create a new {normalise_resource_type_to_singular(resource_type)}"
        )
    )

    return links


# ==================== Import-Specific Links ====================

def get_import_result_links(request: Request) -> List[Link]:
    """
    Generate links after successful import operation.

    Provides navigation to view the import batch details, view imported transactions,
    and initiate another import.

    Args:
        request: FastAPI Request object
        batch_id: ID of the import batch

    Returns:
        List of links for post-import actions

    Example:
        links = get_import_result_links(request, batch_id=123)
        # Returns: [batch_details, imported_transactions, new_import, import_history]
    """
    base_url = get_base_url(request)
    return [
        Link(
            rel="transactions",
            href=HttpUrl(f"{base_url}/api/transactions"),
            method="GET",
            title="View imported transactions"
        ),
        Link(
            rel="new_import",
            href=HttpUrl(f"{base_url}/api/import/csv"),
            method="POST",
            title="Import another CSV file"
        ),
        Link(
            rel="import_history",
            href=HttpUrl(f"{base_url}/api/import/batches"),
            method="GET",
            title="View import history"
        ),
    ]
