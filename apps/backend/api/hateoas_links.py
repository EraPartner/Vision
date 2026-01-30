"""
Centralised HATEOAS links factory for REST Level 3 API discovery.

This module provides factory functions for generating consistent hypermedia links
across all API endpoints, ensuring uniform link patterns and discoverability.
"""
from typing import List

from fastapi import Request

from api.api_schemas import Link


# ==================== Base URL Helper ====================

def get_base_url(request: Request) -> str:
    """Extract and normalise base URL from request."""
    return str(request.base_url).rstrip('/')


# ==================== Root/Discovery Links ====================

def get_root_links(request: Request) -> List[Link]:
    """
    Generate links for the API root discovery endpoint.

    Returns:
        List of links to all major resource endpoints
    """
    base_url = get_base_url(request)
    return [
        Link(rel="self", href=f"{base_url}/api/", method="GET", title="API root"),
        Link(rel="admin", href=f"{base_url}/api/admin", method="GET", title="Admin status"),
        Link(rel="categories", href=f"{base_url}/api/categories", method="GET", title="List categories"),
        Link(rel="transactions", href=f"{base_url}/api/transactions", method="GET", title="List transactions"),
        Link(rel="recipients", href=f"{base_url}/api/recipients", method="GET", title="List recipients"),
        Link(rel="statistics", href=f"{base_url}/api/statistics", method="GET", title="View statistics"),
        Link(rel="import", href=f"{base_url}/api/import/csv", method="POST", title="Import transactions"),
    ]


# ==================== Pagination Links ====================

def get_pagination_links(
        request: Request,
        endpoint: str,
        limit: int,
        offset: int,
        total: int,
        **query_params
) -> List[Link]:
    """
    Generate pagination links (self, prev, next) for list endpoints.

    Args:
        request: FastAPI Request object
        endpoint: API endpoint path (e.g., '/api/categories')
        limit: Current page limit
        offset: Current page offset
        total: Total number of items
        **query_params: Additional query parameters to include in links

    Returns:
        List of pagination links
    """
    base_url = get_base_url(request)

    # Build query string from additional parameters
    query_string = ''.join(f"&{k}={v}" for k, v in query_params.items() if v is not None)

    links = [
        Link(
            rel="self",
            href=f"{base_url}{endpoint}?limit={limit}&offset={offset}{query_string}",
            method="GET",
            title="Current page"
        )
    ]

    # Previous link
    if offset > 0:
        new_offset = max(0, offset - limit)
        links.append(
            Link(
                rel="prev",
                href=f"{base_url}{endpoint}?limit={limit}&offset={new_offset}{query_string}",
                method="GET",
                title="Previous page"
            )
        )

    # Next link
    if offset + limit < total:
        new_offset = offset + limit
        links.append(
            Link(
                rel="next",
                href=f"{base_url}{endpoint}?limit={limit}&offset={new_offset}{query_string}",
                method="GET",
                title="Next page"
            )
        )

    return links


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
            href=f"{base_url}/api/{resource_type}/{resource_id}",
            method="GET",
            title=f"Get this {resource_type[:-1]}"
        ),
        Link(
            rel="update",
            href=f"{base_url}/api/{resource_type}/{resource_id}",
            method="PATCH",
            title=f"Update this {resource_type[:-1]}"
        ),
        Link(
            rel="delete",
            href=f"{base_url}/api/{resource_type}/{resource_id}",
            method="DELETE",
            title=f"Delete this {resource_type[:-1]}"
        ),
        Link(
            rel="list",
            href=f"{base_url}/api/{resource_type}",
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
            href=f"{base_url}/api/{resource_type}",
            method="GET",
            title=f"List remaining {resource_type}"
        ),
        Link(
            rel="create",
            href=f"{base_url}/api/{resource_type}",
            method="POST",
            title=f"Create a new {resource_type[:-1]}"
        ),
    ]
