"""
API routes for category management

Handles all category-related endpoints.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.api_schemas import (
    CategoryResponse, AssignCategoryRequest, CategoryBase
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.category_service import CategoryService

router = APIRouter(prefix="/api", tags=["categories"])
logger = setup_logging(__name__)


@router.get("/categories")
async def get_categories(
        limit: int = Query(100, ge=1, le=5000, description="Maximum number of categories to return"),
        offset: int = Query(0, ge=0, description="Number of categories to skip for pagination"),
        db: Session = Depends(get_db)
):
    """Get all categories.

    Retrieves a list of active categories with pagination support.

    Args:
        limit (int): Maximum number of categories to return (1-5000). Defaults to 1000.
        offset (int): Number of categories to skip before returning results. Defaults to 0.
        db (Session): Database session dependency.

    Returns:
        list[dict]: List of category dictionaries containing:
            - id (int)
            - general (str)
            - detail (str)
            - description (str)
            - color (str)
            - created_at (datetime)

    Raises:
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        categories = service.get_all_flat(limit=limit, offset=offset)
        logger.info(f"Retrieved {len(categories)} categories (offset={offset}, limit={limit})")
        return [{
            "id": c.id,
            "general": c.general,
            "detail": c.detail,
            "description": c.description,
            "color": c.color,
            "created_at": c.created_at
        } for c in categories]
    except Exception as e:
        logger.error(f"Error retrieving categories: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving categories")


@router.post("/categories", response_model=CategoryResponse)
async def get_or_create_category(
        category: CategoryBase,
        db: Session = Depends(get_db)
):
    """Create a new category or return existing one in General:Detail format.

    Creates a new category with the specified general and detail names. If a category
    with the same general:detail combination already exists, returns the existing category.

    Args:
        category (CategoryCreate): Category creation data including general, detail,
            description, and color.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The created or existing category.

    Raises:
        HTTPException: 400 error for validation errors.
        HTTPException: 500 error if creation fails.
    """
    try:
        service = CategoryService(db)
        new_category = service.get_or_create_category(
            general=category.genera,
            detail=category.detail,
            description=category.description,
            color=category.color
        )
        return CategoryResponse.model_validate(new_category)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error creating category")


@router.get("/categories/{category_id}", response_model=CategoryResponse)
async def get_category(
        category_id: int,
        db: Session = Depends(get_db)
):
    """Get a specific category by ID.

    Retrieves detailed information for a single category identified by its ID.

    Args:
        category_id (int): The ID of the category to retrieve.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The requested category details.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_by_id(category_id)
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category")


@router.put("/categories/{category_id}", response_model=CategoryResponse)
async def update_category(
        category_id: int,
        category_update: CategoryBase,
        db: Session = Depends(get_db)
):
    """Update an existing category.

    Updates the specified category with new values for name, description, and/or color.

    Args:
        category_id (int): The ID of the category to update.
        category_update (CategoryCreate): Updated category data.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The updated category.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if update fails.
    """
    try:
        service = CategoryService(db)
        category = service.update(
            category_id=category_id,
            general=category_update.general,
            detail=category_update.detail,
            description=category_update.description,
            color=category_update.color
        )
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error updating category")


@router.delete("/categories/{category_id}")
async def delete_category(category_id: int, db: Session = Depends(get_db)):
    """Delete a category (soft delete - mark as inactive).

    Performs a soft delete by marking the category as inactive rather than removing
    it from the database. This preserves historical data integrity.

    Args:
        category_id (int): The ID of the category to delete.
        db (Session): Database session dependency.

    Returns:
        dict: Success message confirming deletion.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if deletion fails.
    """
    try:
        service = CategoryService(db)
        if not service.delete(category_id):
            raise HTTPException(status_code=404, detail="Category not found")
        return {"message": "Category deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error deleting category")


@router.post("/categories/assign")
async def assign_category(request: AssignCategoryRequest, db: Session = Depends(get_db)):
    """Assign category to one or many recipients.

    Assigns a default category to either a single recipient (using recipient_id) or
    multiple recipients (using recipient_ids). The category is created if it doesn't exist.

    Args:
        request (AssignCategoryRequest): Assignment request containing:
            - category_name (str): Name of the category to assign
            - recipient_id (int, optional): Single recipient ID
            - recipient_ids (list[int], optional): Multiple recipient IDs
        db (Session): Database session dependency.

    Returns:
        dict: Number of recipients updated.

    Raises:
        HTTPException: 400 error if neither recipient_id nor recipient_ids provided.
        HTTPException: 404 error if recipient not found.
        HTTPException: 500 error if assignment fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_or_create_category(request.category_general, request.category_detail)
        updated_count = service.assign_category(
            recipient_ids=request.recipient_ids,
            category=category,
        )
        return {"updated_recipients": updated_count}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error assigning category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error assigning category")


@router.get("/categories/path")
async def get_category_by_path(
        category: CategoryBase,
        db: Session = Depends(get_db)
):
    """Get category by General:Detail path.

    Retrieves a category based on its general and detail names.

    Args:
        category (CategoryBase): Category path data including general and detail names.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The requested category details.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_by_general_detail(category.general, category.detail)
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving category {category.general}:{category.detail}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category")
