"""
Centralised HATEOAS links factory for REST Level 3 API discovery.

This module provides a `HateoasService` that generates consistent hypermedia
links across all API endpoints. The module also exposes the original function
names as thin wrappers for backwards compatibility.
"""
from typing import List

from fastapi import Request
from pydantic import HttpUrl

from api.api_schemas import Link
from config.config import get_settings


class HateoasService:
    """Service encapsulating HATEOAS link generation logic.

    This class centralises helpers and link-generation routines so the
    functionality can be reused, unit tested, and (if needed) injected.
    """

    def _get_base_url(self, request: Request) -> str:
        """Extract and normalise base URL from request."""
        return str(request.base_url).rstrip('/')

    def _normalise_resource_type_to_singular(self, resource_type: str) -> str:
        """Normalise resource type (e.g., 'transactions' -> 'transaction')."""
        if resource_type == 'categories':
            return 'category'
        return str(resource_type).lower()[:-1]

    def get_root_links(self, request: Request) -> List[Link]:
        base_url = self._get_base_url(request)
        return [
            Link(rel="self", href=HttpUrl(f"{base_url}/api/"), method="GET", title="API root"),
            Link(rel="admin", href=HttpUrl(f"{base_url}/api/admin"), method="GET", title="Admin status"),
            Link(rel="categories", href=HttpUrl(f"{base_url}/api/categories"), method="GET", title="List categories"),
            Link(rel="transactions", href=HttpUrl(f"{base_url}/api/transactions"), method="GET", title="List transactions"),
            Link(rel="recipients", href=HttpUrl(f"{base_url}/api/recipients"), method="GET", title="List recipients"),
            Link(rel="info", href=HttpUrl(f"{base_url}/api/info"), method="GET", title="View info"),
            Link(rel="import", href=HttpUrl(f"{base_url}/api/import/csv"), method="POST", title="Import transactions"),
        ]

    def get_resource_links(self, request: Request, resource_type: str, resource_id: int) -> List[Link]:
        base_url = self._get_base_url(request)
        singular = self._normalise_resource_type_to_singular(resource_type)
        return [
            Link(
                rel="self",
                href=HttpUrl(f"{base_url}/api/{resource_type}/{resource_id}"),
                method="GET",
                title=f"Get this {singular}"
            ),
            Link(
                rel="update",
                href=HttpUrl(f"{base_url}/api/{resource_type}/{resource_id}"),
                method="PATCH",
                title=f"Update this {singular}"
            ),
            Link(
                rel="delete",
                href=HttpUrl(f"{base_url}/api/{resource_type}/{resource_id}"),
                method="DELETE",
                title=f"Delete this {singular}"
            ),
            Link(
                rel="list",
                href=HttpUrl(f"{base_url}/api/{resource_type}"),
                method="GET",
                title=f"List all {resource_type}"
            ),
        ]

    def get_deletion_response_links(self, request: Request, resource_type: str) -> List[Link]:
        base_url = self._get_base_url(request)
        singular = self._normalise_resource_type_to_singular(resource_type)
        return [
            Link(rel="list", href=HttpUrl(f"{base_url}/api/{resource_type}"), method="GET", title=f"List remaining {resource_type}"),
            Link(rel="create", href=HttpUrl(f"{base_url}/api/{resource_type}"), method="POST", title=f"Create a new {singular}"),
        ]

    def get_collection_links(self, request: Request, resource_type: str, limit: int, offset: int, total: int, **query_params) -> List[Link]:
        base_url = self._get_base_url(request)
        endpoint = f"/api/{resource_type}"
        query_string = ''.join(f"&{k}={v}" for k, v in query_params.items() if v is not None)

        links = [
            Link(rel="self", href=HttpUrl(f"{base_url}{endpoint}?limit={limit}&offset={offset}{query_string}"), method="GET", title="Current page")
        ]

        if offset > 0:
            new_offset = max(0, offset - limit)
            links.append(Link(rel="prev", href=HttpUrl(f"{base_url}{endpoint}?limit={limit}&offset={new_offset}{query_string}"), method="GET", title="Previous page"))

        if offset + limit < total:
            new_offset = offset + limit
            links.append(Link(rel="next", href=HttpUrl(f"{base_url}{endpoint}?limit={limit}&offset={new_offset}{query_string}"), method="GET", title="Next page"))

        links.append(Link(rel="create", href=HttpUrl(f"{base_url}{endpoint}"), method="POST", title=f"Create a new {self._normalise_resource_type_to_singular(resource_type)}"))

        return links

    def get_import_result_links(self, request: Request) -> List[Link]:
        base_url = self._get_base_url(request)
        return [
            Link(rel="transactions", href=HttpUrl(f"{base_url}/api/transactions"), method="GET", title="View imported transactions"),
            Link(rel="new_import", href=HttpUrl(f"{base_url}/api/import/csv"), method="POST", title="Import another CSV file"),
            Link(rel="import_history", href=HttpUrl(f"{base_url}/api/import/batches"), method="GET", title="View import history"),
        ]

    def generate_admin_links(self, request: Request) -> List[Link]:
        base_url = self._get_base_url(request)
        links = [
            Link(rel="self", href=HttpUrl(f"{base_url}/api/admin"), method="GET", title="Get current database administration status"),
            Link(rel="init", href=HttpUrl(f"{base_url}/api/admin/database/init"), method="POST", title="Initialise the database"),
        ]

        settings = get_settings()
        if getattr(settings, 'admin', None) and getattr(settings.admin, 'enable_reset_db', False):
            links.append(Link(rel="reset", href=HttpUrl(f"{base_url}/api/admin/database/reset?force=true"), method="POST", title="Reset the database (DESTRUCTIVE - requires force parameter)"))

        return links


# Module-level instance for simple import/usage
hateoas_service = HateoasService()

# Backwards-compatible function wrappers
def get_base_url(request: Request) -> str:
    return hateoas_service._get_base_url(request)


def normalise_resource_type_to_singular(resource_type: str) -> str:
    return hateoas_service._normalise_resource_type_to_singular(resource_type)


def get_root_links(request: Request) -> List[Link]:
    return hateoas_service.get_root_links(request)


def get_resource_links(request: Request, resource_type: str, resource_id: int) -> List[Link]:
    return hateoas_service.get_resource_links(request, resource_type, resource_id)


def get_deletion_response_links(request: Request, resource_type: str) -> List[Link]:
    return hateoas_service.get_deletion_response_links(request, resource_type)


def get_collection_links(request: Request, resource_type: str, limit: int, offset: int, total: int, **query_params) -> List[Link]:
    return hateoas_service.get_collection_links(request, resource_type, limit, offset, total, **query_params)


def get_import_result_links(request: Request) -> List[Link]:
    return hateoas_service.get_import_result_links(request)


def generate_admin_links(request: Request) -> List[Link]:
    return hateoas_service.generate_admin_links(request)