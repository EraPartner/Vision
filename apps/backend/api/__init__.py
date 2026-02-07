"""
API Package Module

This package exports all route routers for easy import in main.py
"""

from api.api_routes_admin import router as admin_router  # ensure this file exists
from api.api_routes_categories import router as categories_router
from api.api_routes_import import router as import_router
from api.api_routes_info import router as info_router
from api.api_routes_recipients import router as recipients_router
from api.api_routes_transactions import router as transactions_router

__all__ = [
    "transactions_router",
    "categories_router",
    "recipients_router",
    "info_router",
    "import_router",
    "admin_router",
]
