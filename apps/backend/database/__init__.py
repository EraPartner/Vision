"""
Database package for Financial Transaction Manager API.

This package contains database models, connection handling, and related utilities.
"""

from .models import Base  # re-export Base for stable imports

__all__ = ["Base"]
